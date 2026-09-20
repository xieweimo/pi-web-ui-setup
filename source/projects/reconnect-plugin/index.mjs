/**
 * reconnect —— 断连恢复（独立插件）。
 *
 * 只做两件事，和「同步」插件完全无关：
 *   1. 报告本机重启守护（scripts/pi-web-ui-recovery-watchdog.js，监听 127.0.0.1:8788）是否就绪；
 *   2. 代理一次「重启网页服务」请求 —— 由服务端去 POST 守护进程的 /restart，
 *      浏览器不必跨源直连 8788，也不受 CORS 限制。
 *
 * 页面真的断连时用不了本插件（服务都连不上），那种情况由前端补丁
 * patches/patch-pi-web-ui-recovery-ui.js 注入的浮层兜底；本插件是「连着的时候主动重连/重启」的入口。
 */
import http from "node:http";

const WATCHDOG_HOST = "127.0.0.1";
const WATCHDOG_PORT = 8788;

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
			res.resume();
			finish({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0 });
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
			const probe = await callWatchdog("/", "GET");
			res.json({
				ok: true,
				// 服务端能响应，说明网页服务在线。
				service: true,
				// status 0 = 连不上守护进程（404 也算连得上）。
				watchdog: probe.status !== 0,
				watchdogStatus: probe.status,
				watchdogError: probe.error ?? null,
			});
		});

		host.route("POST", "/restart", async (_req, res) => {
			const result = await callWatchdog("/restart", "POST", 5000);
			if (result.status === 0) {
				return res.status(503).json({
					ok: false,
					error: "重启守护未运行：请关闭本页后重新运行「启动 Pi 网页版」（守护由启动器拉起）",
				});
			}
			res.json({ ok: true, watchdogStatus: result.status });
		});

		return () => {};
	},
};
