/**
 * proxy-health —— 代理连通性探测与告警。
 *
 * 通过 HTTP(S) 代理 CONNECT → TLS → GET 检查可配置的 HTTPS 目标；
 * 无代理时尝试直连，不把「无代理」自动判为故障。目标失败时探对照站点，
 * 只报告观测到的链路状态，不把目标不可达武断归因于某个代理节点。
 *
 * 幂等、绝不抛错：所有异常都收敛到状态里，不影响宿主与其它插件。
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAIN_URL = "https://chatgpt.com/backend-api/wham/usage";
const CONTROL_URL = "https://www.google.com/generate_204";

/** 状态：loading / ok / target / down / direct / config */
const BADGE = {
	loading: { label: "🌐 …", labelEn: "🌐 …", hint: "正在探测代理连通性…", hintEn: "Probing proxy…" },
	ok: { label: "🌐", labelEn: "🌐", hint: "目标站点可达", hintEn: "Target is reachable" },
	target: {
		label: "⚠ 目标站点不可达",
		labelEn: "⚠ Target unreachable",
		hint: "目标站点探测失败，但对照站点可达；请检查目标服务、代理路由或节点",
		hintEn: "Target failed while the control site is reachable; check the service, proxy routing or node",
	},
	down: {
		label: "⚠ 代理链路不可用",
		labelEn: "⚠ Proxy path unavailable",
		hint: "目标和对照站点均无法经代理访问；请检查代理服务和网络",
		hintEn: "Neither site is reachable through the proxy; check the proxy and network",
	},
	direct: {
		label: "⚠ 直连不可用",
		labelEn: "⚠ Direct connection failed",
		hint: "未配置代理且直连目标失败；如需代理，请在插件设置或 pi 设置中配置",
		hintEn: "No proxy is configured and direct access failed; configure one if needed",
	},
	config: {
		label: "⚠ 探测配置无效",
		labelEn: "⚠ Invalid probe settings",
		hint: "探测目标须为不带账号密码的 HTTPS URL，代理须为 HTTP(S) URL",
		hintEn: "Probe URLs must be credential-free HTTPS URLs; proxy must be HTTP(S)",
	},
};

/** 读代理地址：插件设置优先 → pi settings.json 的 httpProxy → 环境变量。
 *  `PI_AGENT_SETTINGS_FILE` 可覆盖 settings 路径（测试用，也适配非默认 pi 数据目录）。 */
function resolveProxy(fromSettings) {
	const direct = String(fromSettings ?? "").trim();
	if (direct) return direct;
	try {
		const file = process.env.PI_AGENT_SETTINGS_FILE || path.join(os.homedir(), ".pi", "agent", "settings.json");
		const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
		const v = typeof cfg?.httpProxy === "string" ? cfg.httpProxy.trim() : "";
		if (v) return v;
	} catch {
		/* 配置缺失或不可读都当作没配到 */
	}
	return (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim();
}

/** 解析 HTTP/1.1 原始响应的状态码（拿不到起始行 = 隧道没跑通）。 */
function parseStatus(buf) {
	const split = buf.indexOf("\r\n\r\n");
	if (split < 0) return 0;
	const line = buf.subarray(0, split).toString("latin1").split("\r\n")[0] || "";
	return Number(line.split(" ")[1]) || 0;
}

/**
 * 经 HTTP 代理 CONNECT 隧道发一个 GET。返回 HTTP 状态码（>0 即隧道打通）。
 * 任何建连/握手/超时问题都 reject，由调用方归类。
 */
export function probeViaProxy(url, proxy, timeoutMs) {
	return new Promise((resolve, reject) => {
		let target;
		let px;
		try {
			target = new URL(url);
			px = new URL(proxy);
		} catch (err) {
			reject(new Error(`代理地址无法解析：${err?.message ?? err}`));
			return;
		}
		const port = px.port ? Number(px.port) : px.protocol === "https:" ? 443 : 80;
		if (!/^https?:$/.test(px.protocol)) {
			reject(new Error("仅支持 HTTP(S) 代理；SOCKS 请使用 HTTP 混合端口"));
			return;
		}
		const headers = { Host: `${target.hostname}:443` };
		if (px.username || px.password) {
			headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`).toString("base64")}`;
		}
		const req = (px.protocol === "https:" ? https : http).request({
			host: px.hostname,
			port,
			method: "CONNECT",
			path: `${target.hostname}:443`,
			headers,
			timeout: timeoutMs,
		});
		let settled = false;
		const done = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		req.on("connect", (res, socket) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				done(reject, new Error(`代理 CONNECT 被拒：HTTP ${res.statusCode}`));
				return;
			}
			const s = tls.connect({ socket, servername: target.hostname }, () => {
				const lines = [
					`GET ${target.pathname}${target.search} HTTP/1.1`,
					`Host: ${target.hostname}`,
					"User-Agent: proxy-health/1.0",
					"Accept: */*",
					"Accept-Encoding: identity",
					"Connection: close",
				];
				s.write(`${lines.join("\r\n")}\r\n\r\n`);
			});
			let header = Buffer.alloc(0);
			s.on("data", (chunk) => {
				header = Buffer.concat([header, chunk]);
				const status = parseStatus(header);
				if (status || header.length > 8192) {
					done(resolve, status);
					s.destroy();
				}
			});
			s.on("end", () => done(resolve, parseStatus(header)));
			s.on("error", (err) => done(reject, err));
			s.setTimeout(timeoutMs, () => {
				s.destroy();
				done(reject, new Error("TLS 响应超时"));
			});
		});
		req.on("timeout", () => {
			req.destroy();
			done(reject, new Error("代理建连超时"));
		});
		req.on("error", (err) => done(reject, err));
		req.end();
	});
}

function probeDirect(url, timeoutMs) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { timeout: timeoutMs }, (res) => {
			res.resume();
			resolve(res.statusCode || 0);
		});
		req.on("timeout", () => req.destroy(new Error("直连超时")));
		req.on("error", reject);
	});
}

/** 测试注入探测函数，生产实例始终使用真实网络。 */
export function createProxyHealthPlugin({ probeNetwork = probeViaProxy, directProbe = probeDirect, resolve = resolveProxy } = {}) {
	return {
	activate(host) {
		const readCfg = () => host.getSettings?.() ?? {};
		let cfg = readCfg();
		let timer = null;
		let running = false;
		/** 当前状态，用于只在「状态切换」时通知，避免每轮刷屏。 */
		let state = "loading";
		let lastReason = "";
		let consecutiveFails = 0;

		const interval = () => Math.min(Math.max(Number(cfg.intervalSec) || 30, 10), 600);
		const timeoutMs = () => Math.min(Math.max(Number(cfg.timeoutMs) || 8000, 1000), 30000);
		const threshold = () => Math.min(Math.max(Number(cfg.failThreshold) || 2, 1), 5);

		/** 把状态写进底部状态栏；宿主不支持时静默跳过。 */
		function paintBadge(next, reason) {
			if (cfg.showBadge === false || typeof host.ui?.update !== "function") return;
			const meta = BADGE[next] ?? BADGE.loading;
			try {
				host.ui.update("bar", {
					label: meta.label,
					labelEn: meta.labelEn,
					hint: reason ? `${meta.hint}（${reason}）` : meta.hint,
					hintEn: reason ? `${meta.hintEn} (${reason})` : meta.hintEn,
				});
			} catch {
				/* 状态栏更新失败不影响探测本身 */
			}
		}

		function notify(level, zh, en) {
			if (cfg.notifyOnChange === false) return;
			try {
				host.notify?.(level, zh, en);
			} catch {
				/* 通知失败忽略 */
			}
		}

		/** 状态切换时通知一次；同状态不重复打扰。启动首探（loading→ok）保持安静。 */
		function transition(next, reason) {
			const prev = state;
			const changed = next !== state;
			state = next;
			lastReason = reason;
			paintBadge(next, reason);
			if (!changed || cfg.notifyOnChange === false) return;
			if (next === "ok") {
				if (prev === "target" || prev === "down" || prev === "direct" || prev === "config") {
					notify("info", "目标站点已恢复可达。", "Target is reachable again.");
				}
				return;
			}
			if (next === "config") {
				notify("warning", "探测配置无效：检查 HTTPS 目标和 HTTP(S) 代理地址。", "Invalid probe settings: check HTTPS targets and HTTP(S) proxy URL.");
			} else if (next === "direct") {
				notify("warning", "未配置代理，且目标站点直连失败；请检查网络或按需配置代理。", "Direct access failed with no proxy configured; check the network or configure a proxy if needed.");
			} else if (next === "down") {
				notify("warning", "目标和对照站点经代理均不可达；请检查代理服务或网络。", "Neither site is reachable through the proxy; check the proxy or network.");
			} else if (next === "target") {
				notify("warning", "目标站点探测失败，但对照站点可达；请检查目标服务、代理路由或节点。", "Target failed while the control site is reachable; check the service, proxy route or node.");
			}
		}

		async function probe() {
			if (running) return;
			running = true;
			try {
				const proxy = resolve(cfg.proxy);
				const target = new URL(String(cfg.targetUrl || MAIN_URL));
				const control = new URL(String(cfg.controlUrl || CONTROL_URL));
				if ([target, control].some((url) => url.protocol !== "https:" || url.username || url.password)) {
					transition("config", "仅支持不带凭证的 HTTPS 探测目标");
					return;
				}
				if (proxy && !/^https?:$/.test(new URL(proxy).protocol)) {
					transition("config", "仅支持 HTTP(S) 代理");
					return;
				}
				let status = 0;
				let errText = "";
				try {
					status = proxy ? await probeNetwork(target.href, proxy, timeoutMs()) : await directProbe(target.href, timeoutMs());
				} catch (err) {
					errText = String(err?.message ?? err).replace(/https?:\/\/\S+/g, "[URL]").slice(0, 80);
				}
				if (status > 0) {
					consecutiveFails = 0;
					transition("ok", `HTTP ${status}${proxy ? "（经代理）" : "（直连）"}`);
					return;
				}
				consecutiveFails += 1;
				if (consecutiveFails < threshold()) {
					paintBadge(state, `连续第 ${consecutiveFails} 次失败，未达阈值`);
					return;
				}
				if (!proxy) {
					transition("direct", errText || "直连失败");
					return;
				}
				let controlOk = false;
				try {
					controlOk = (await probeNetwork(control.href, proxy, timeoutMs())) > 0;
				} catch {
					controlOk = false;
				}
				transition(controlOk ? "target" : "down", errText || "探测失败");
			} catch (err) {
				lastReason = "探测配置或执行异常";
				host.log?.("warn", "[proxy-health] 探测异常（已隐去配置详情）");
				transition("config", lastReason);
			} finally {
				running = false;
			}
		}

		function arm() {
			if (timer) clearInterval(timer);
			timer = setInterval(() => void probe(), interval() * 1000);
		}

		// 首次立即探一次，启动就能看到真实状态
		void probe();
		arm();

		// 可探测性：激活日志 + /state 路由。否则插件到底挂没挂上只能靠猜
		// （2026-09-29 验收时就差点因为「日志里没它」误判成没激活）。
		let proxyShown = "(未读到)";
		try {
			const px = new URL(resolve(cfg.proxy));
			proxyShown = `${px.hostname}:${px.port || (px.protocol === "https:" ? 443 : 80)}`;
		} catch {
			proxyShown = "(未读到)";
		}
		host.log?.("info", `[proxy-health] activated; interval=${interval()}s timeout=${timeoutMs()}ms threshold=${threshold()} proxy=${proxyShown}`);
		const offRoute = host.route?.("GET", "/state", (_req, res) => {
			res.json({
				ok: true,
				plugin: "proxy-health",
				state,
				reason: lastReason,
				consecutiveFails,
				intervalSec: interval(),
				timeoutMs: timeoutMs(),
				proxy: proxyShown,
				checkedAt: Date.now(),
			});
		});

		const offSettings = host.onSettingsChanged?.((values) => {
			cfg = { ...cfg, ...values };
			consecutiveFails = 0;
			arm();
			void probe();
		});

		return () => {
			if (timer) clearInterval(timer);
			timer = null;
			try {
				offSettings?.();
				offRoute?.();
			} catch {
				/* 清理失败忽略 */
			}
		};
	},
};
}

export default createProxyHealthPlugin();
