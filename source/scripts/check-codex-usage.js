#!/usr/bin/env node
/**
 * codex-usage 插件自检脚本（pi-web-ui 升级后 / 排查显示异常时跑一次）
 *
 * 用 Edge headless + CDP 打开 pi-web-ui，可选先触发插件热重载，然后检查：
 *   1. 插件 tab 是否出现（⚡ 额度）
 *   2. 底部状态栏是否出现摘要（⚡ ¥x.xx 或 ⚡ 5h 24% · 7d 4%）
 *   3. 原生「$ 累计成本」项是否按设置被隐藏
 *   4. 插件 tab 里的元数据：当前模型、服务进程代理、dispatcher 是否已配置
 *   5. 截图（便于肉眼确认）
 *
 * 用法：
 *   node scripts/check-codex-usage.js                # 只检查
 *   node scripts/check-codex-usage.js --reload       # 先热重载插件（改了插件代码后用）
 *   node scripts/check-codex-usage.js --port 8787 --out .tmp-check.png
 *
 * 说明：需要系统里有 Edge（Windows 自带）；不发送任何模型请求，不消耗额度。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** 从 pi-web-ui 包目录借用 ws（避免本仓库额外装依赖）。 */
function loadWs() {
	const candidates = [
		path.join(process.env.APPDATA || "", "npm", "node_modules", "pi-web-ui", "node_modules", "ws"),
	];
	for (const c of candidates) {
		try {
			return require(c);
		} catch {
			/* 继续找 */
		}
	}
	console.error("✗ 找不到 ws 模块（需要已全局安装 pi-web-ui）");
	process.exit(1);
}

const EDGE_CANDIDATES = [
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const args = process.argv.slice(2);
function flag(name, fallback) {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT_WEB = Number(flag("port", "8787"));
const OUT = path.resolve(flag("out", ".tmp-codex-usage-check.png"));
const DO_RELOAD = args.includes("--reload");
const CDP_PORT = Number(flag("cdp-port", "9334"));
const CDP_DIR = path.join(require("node:os").tmpdir(), `codex-usage-check-${process.pid}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
	if (!edge) {
		console.error("✗ 找不到 Edge 可执行文件");
		process.exit(1);
	}

	const child = spawn(
		edge,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${CDP_DIR}`,
			"--window-size=1600,1000",
			`http://127.0.0.1:${PORT_WEB}/`,
		],
		{ stdio: "ignore" },
	);

	let target = null;
	for (let i = 0; i < 40 && !target; i++) {
		await sleep(500);
		try {
			const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
			target = list.find((t) => t.type === "page" && t.url.includes(String(PORT_WEB)));
		} catch {
			/* 还没起来 */
		}
	}
	if (!target) {
		child.kill();
		console.error("✗ 浏览器 CDP 目标未就绪（pi-web-ui 服务在跑吗？）");
		process.exit(1);
	}

	const WS = loadWs();
	const ws = new WS(target.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();
	ws.on("message", (raw) => {
		const msg = JSON.parse(raw.toString());
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg.result);
			pending.delete(msg.id);
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const mid = ++id;
			pending.set(mid, resolve);
			ws.send(JSON.stringify({ id: mid, method, params }));
		});

	await new Promise((r) => ws.on("open", r));
	await send("Runtime.enable");

	if (DO_RELOAD) {
		// 必须先 hello：服务端在 attach 完成前会把消息压在 pending 队列里不执行
		const r = await send("Runtime.evaluate", {
			expression: `new Promise(res => {
				const w = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
				w.onopen = () => {
					w.send(JSON.stringify({ type: 'hello', clientId: 'codex-usage-check' }));
					setTimeout(() => {
						w.send(JSON.stringify({ type: 'plugins_reload' }));
						setTimeout(() => { w.close(); res('reload-sent'); }, 1500);
					}, 1500);
				};
				w.onerror = () => res('reload-error');
			})`,
			awaitPromise: true,
			returnByValue: true,
		});
		console.log("插件热重载：", r?.result?.value);
		await sleep(3000);
		await send("Page.reload", { ignoreCache: true });
		await sleep(7000);
	} else {
		await sleep(9000);
	}

	const probe = `(async () => {
		for (let i = 0; i < 40; i++) {
			if (document.getElementById('codex-usage-statusbar')) break;
			await new Promise(r => setTimeout(r, 500));
		}
		const costItem = [...document.querySelectorAll('.statusbar .status-item')].find(n => /累计成本|Cumulative cost/i.test(n.getAttribute('title') || ''));
		window.__piWebUiHost?.setView?.('plugin:codex-usage');
		await new Promise(r => setTimeout(r, 1200));
		return JSON.stringify({
			pluginTab: [...document.querySelectorAll('.plugin-tab')].map(n => n.innerText.replace(/\\n/g, ' ')),
			statusBarSummary: document.getElementById('codex-usage-statusbar')?.textContent ?? null,
			nativeCostHidden: costItem ? costItem.style.display === 'none' : null,
			meta: document.querySelector('.cu-meta')?.innerText ?? null
		});
	})()`;
	const res = await send("Runtime.evaluate", { expression: probe, awaitPromise: true, returnByValue: true });
	const data = res?.result?.value ? JSON.parse(res.result.value) : null;

	console.log("\n=== codex-usage 自检结果 ===");
	if (!data) {
		console.log("✗ 页面探测失败");
	} else {
		console.log("插件 tab：", data.pluginTab.join(" / ") || "（未出现）");
		console.log("状态栏摘要：", data.statusBarSummary ?? "（未注入）");
		console.log("原生成本项已隐藏：", data.nativeCostHidden);
		console.log("插件元数据：\n" + (data.meta ?? "（读不到）").split("\n").map((l) => "  " + l).join("\n"));
		const ok = Boolean(data.statusBarSummary) && data.pluginTab.length > 0;
		console.log(ok ? "\n✓ 插件工作正常" : "\n✗ 插件未生效（看上面的空项）");
	}

	const shot = await send("Page.captureScreenshot", { format: "png" });
	if (shot?.data) {
		fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
		console.log("截图：", OUT);
	}

	ws.close();
	child.kill();
	await sleep(500);
	fs.rmSync(CDP_DIR, { recursive: true, force: true });
	process.exit(0);
}

main().catch((e) => {
	console.error("✗ " + e.message);
	process.exit(1);
});
