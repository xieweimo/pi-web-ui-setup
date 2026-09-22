/**
 * reconnect —— 断连恢复（独立插件）。
 *
 * 只做两件事，和「同步」插件完全无关：
 *   1. 报告本机重启守护（scripts/pi-web-ui-recovery-watchdog.js）是否就绪；
 *   2. 代理一次「重启网页服务」请求 —— 由服务端去 POST 守护进程的 /restart，
 *      浏览器不必跨源直连守护端口，也不受 CORS 限制。
 *
 * 断连时本插件依然可用：客户端的状态查询与操作在走后端失败后会**直连 watchdog**
 * （127.0.0.1:8790），所以“页面连不上后端”也能重启服务。
 * 0.94.1 起不再注入前端断连浮层（patch-pi-web-ui-recovery-ui.js 已停用）——
 * 浮层能做的两件事（重新连接 / 重启网页服务）本插件的顶栏视图都已覆盖。
 */
import http from "node:http";

const WATCHDOG_HOST = "127.0.0.1";
// 8790 避开上游 npm run dev 默认使用的 8788；启动器可通过环境变量改写。
const WATCHDOG_PORT = Number(process.env.PI_WEB_UI_WATCHDOG_PORT || 8790);

/** 探测 / 调用守护进程；永不抛错，失败回 {ok:false}。 */
function callWatchdog(pathname, method = "GET", timeoutMs = 3000) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (value) => {
			if (!done) {
				done = true;
				resolve(value);
			}
		};
		const req = http.request({ host: WATCHDOG_HOST, port: WATCHDOG_PORT, path: pathname, method, timeout: timeoutMs }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => {
				let data = {};
				try { data = body ? JSON.parse(body) : {}; } catch { data = { error: body || `HTTP ${res.statusCode}` }; }
				finish({ ...data, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300 && data.ok !== false, status: res.statusCode ?? 0 });
			});
		});
		req.on("timeout", () => {
			req.destroy();
			finish({ ok: false, status: 0, error: "timeout" });
		});
		req.on("error", (err) => finish({ ok: false, status: 0, error: String(err?.code ?? err?.message ?? err) }));
		req.end();
	});
}

export default {
	activate(host) {
		host.route("GET", "/state", async (_req, res) => {
			const probe = await callWatchdog("/state", "GET");
			res.json({
				...probe,
				ok: true,
				// 当前插件路由能响应，说明后端在线；watchdog 的 healthUrl 可能检查的是 Vite 前端。
				backendOnline: true,
				watchdog: probe.status !== 0,
				watchdogStatus: probe.status,
				watchdogError: probe.error ?? null,
				watchdogPort: probe.watchdogPort || WATCHDOG_PORT,
			});
		});

		const forward = (action) => async (_req, res) => {
			const result = await callWatchdog(`/${action}`, "POST", 5000);
			if (result.status === 0) {
				return res.status(503).json({
					ok: false,
					error: "重启守护未运行：请重新运行对应的 pi-web-ui 启动器",
				});
			}
			if (!result.ok) return res.status(result.status || 500).json({ ok: false, error: result.error || `${action} 失败` });
			res.status(result.status || 202).json(result);
		};
		host.route("POST", "/restart", forward("restart"));
		host.route("POST", "/start", forward("start"));
		host.route("POST", "/stop", forward("stop"));

		return () => {};
	},
};
