#!/usr/bin/env node
/**
 * 顶栏「首帧时间线」实测（体验细节巡检的第一把尺子）
 *
 * 解决什么问题：很多界面问题不是「不出现」，而是「晚出现」——插件入口、状态栏摘要、
 * 余额角标等要等 WebSocket 权威数据到达才渲染，肉眼只觉得"慢半拍"，不量就发现不了。
 * 本脚本用 Edge headless + CDP 记录顶栏每次 DOM 变化的时间戳，直接给出毫秒数。
 *
 * 判据：插件视图入口（.plugin-tab）应在首帧（默认 400ms 预算内）就出现。
 * 超预算即失败（退出码 1），提示把它做成首帧可见或加缓存。
 *
 * 用法：
 *   node scripts/measure-topbar-render.js                    # 正式服务 8787，跑 3 次
 *   node scripts/measure-topbar-render.js --port 5173        # 开发服务
 *   node scripts/measure-topbar-render.js --runs 2 --budget 600
 *   node scripts/measure-topbar-render.js --json             # 只输出 JSON（给脚本消费）
 *
 * 说明：需要系统里有 Edge（Windows 自带）；不发送模型请求，不消耗额度。
 */
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadWs() {
	const candidates = [path.join(process.env.APPDATA || "", "npm", "node_modules", "pi-web-ui", "node_modules", "ws")];
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
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(flag("port", "8787"));
const RUNS = Math.max(1, Number(flag("runs", "3")));
const BUDGET_MS = Number(flag("budget", "400"));
const JSON_ONLY = args.includes("--json");
const SETTLE_MS = Number(flag("settle", "2500"));
const WARMUP_TIMEOUT_MS = Number(flag("warmup-timeout", "20000"));
const CDP_PORT = Number(flag("cdp-port", "9351"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面内注入：记录顶栏条目集合每次变化的时间戳（性能时间轴，单位 ms）。 */
const TIMELINE_HOOK = `
window.__topbarTimeline = [];
(() => {
	const snap = () => {
		const flow = document.querySelector('.topbar-flow');
		if (!flow) return;
		const items = [...flow.querySelectorAll('[data-tip],button,a')]
			.map((n) => (n.innerText || n.getAttribute('data-tip') || '').replace(/\\s+/g, ' ').trim())
			.filter(Boolean);
		const pluginTabs = [...flow.querySelectorAll('.plugin-tab')].length;
		if (items.length === 0) return;
		const key = items.join('|') + '#' + pluginTabs;
		const last = window.__topbarTimeline.at(-1);
		if (last && last.key === key) return;
		window.__topbarTimeline.push({ t: performance.now(), pluginTabs, key, text: items.join(' / ') });
	};
	const start = () => {
		new MutationObserver(snap).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
		snap();
	};
	if (document.documentElement) start();
	else addEventListener('DOMContentLoaded', start, { once: true });
})();
`;

async function main() {
	const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
	if (!edge) {
		console.error("✗ 找不到 Edge 可执行文件");
		process.exit(1);
	}

	const userDataDir = path.join(os.tmpdir(), `pi-topbar-render-${process.pid}`);
	const child = spawn(
		edge,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${userDataDir}`,
			"--window-size=1800,1000",
			"about:blank",
		],
		{ stdio: "ignore" },
	);

	let target = null;
	for (let i = 0; i < 100 && !target; i++) {
		await sleep(50);
		try {
			const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
			target = list.find((t) => t.type === "page");
		} catch {
			/* 还没起来 */
		}
	}
	if (!target) {
		child.kill();
		console.error("✗ 浏览器 CDP 目标未就绪");
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
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Page.addScriptToEvaluateOnNewDocument", { source: TIMELINE_HOOK });

	/** 第一次导航负责预热缓存：固定 sleep 会在服务端 attach 较慢时提前结束，导致第 2 次
	 *  仍是冷启动并被误判为回归。这里明确等到至少一个插件 tab 出现，再开始预算导航。 */
	const waitForPluginTabs = async (timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const r = await send("Runtime.evaluate", {
				expression: `document.querySelectorAll('.topbar-flow .plugin-tab').length`,
				returnByValue: true,
			});
			if ((r?.result?.value ?? 0) > 0) return true;
			await sleep(100);
		}
		return false;
	};

	const runs = [];
	for (let i = 1; i <= RUNS; i++) {
		await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?topbar-timing=${Date.now()}` });
		if (i === 1) {
			await waitForPluginTabs(WARMUP_TIMEOUT_MS);
			await sleep(150); // 让 localStorage 写入 effect 落稳
		} else {
			await sleep(SETTLE_MS);
		}
		const r = await send("Runtime.evaluate", {
			expression: `JSON.stringify({ timeline: window.__topbarTimeline, now: performance.now() })`,
			returnByValue: true,
		});
		const data = r?.result?.value ? JSON.parse(r.result.value) : { timeline: [], now: 0 };
		const firstWithPlugins = data.timeline.find((s) => s.pluginTabs > 0);
		runs.push({
			run: i,
			pluginTabs: data.timeline.at(-1)?.pluginTabs ?? 0,
			firstPaintMs: data.timeline[0]?.t ?? null,
			pluginEntryMs: firstWithPlugins ? Math.round(firstWithPlugins.t) : null,
			steps: data.timeline.map((s) => ({ t: Math.round(s.t), pluginTabs: s.pluginTabs, text: s.text })),
		});
	}

	ws.close();

	// 第 1 次是冷启动基线（可能还没有修复后的缓存），从第 2 次起按预算判定。
	const warmed = runs.slice(1);
	const judged = warmed.length > 0 ? warmed : runs;
	const worst = Math.max(...judged.map((r) => r.pluginEntryMs ?? Number.POSITIVE_INFINITY));
	const ok = Number.isFinite(worst) && worst <= BUDGET_MS;

	if (JSON_ONLY) {
		console.log(JSON.stringify({ port: PORT, budgetMs: BUDGET_MS, ok, runs }, null, 2));
	} else {
		console.log(`=== 顶栏首帧时间线（端口 ${PORT}，预算 ${BUDGET_MS}ms）===`);
		for (const r of runs) {
			const entry = r.pluginEntryMs === null ? "未出现" : `${r.pluginEntryMs}ms`;
			console.log(`第 ${r.run} 次：首帧 ${r.firstPaintMs === null ? "?" : Math.round(r.firstPaintMs) + "ms"} · 插件入口 ${entry} · 插件 tab ${r.pluginTabs} 个`);
			for (const s of r.steps) console.log(`    ${String(s.t).padStart(6)}ms  plugins=${s.pluginTabs}  ${s.text.slice(0, 120)}`);
		}
		console.log(ok ? `\n✓ 插件入口在首帧预算内（最差 ${worst}ms ≤ ${BUDGET_MS}ms）` : `\n✗ 插件入口超出首帧预算：最差 ${Number.isFinite(worst) ? worst + "ms" : "未出现"} > ${BUDGET_MS}ms`);
		if (runs[0].pluginEntryMs !== null && warmed.length > 0 && runs[0].pluginEntryMs > BUDGET_MS && ok) {
			console.log("  注：第 1 次是冷启动基线，判定从第 2 次（缓存预热后）起算。");
		}
	}

	try {
		if (process.platform === "win32") execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		else child.kill();
	} catch {
		/* 已退出 */
	}
	try {
		fs.rmSync(userDataDir, { recursive: true, force: true });
	} catch {
		/* 占用中：留给系统清理 */
	}
	process.exit(ok ? 0 : 1);
}

main().catch((err) => {
	console.error("✗ 实测失败：", err);
	process.exit(1);
});
