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

/**
 * 轮询等待首屏渲染完成（顶栏 + 状态栏就绪），返回实际等待毫秒数，超时返回 -1。
 * 以前这里是写死的 sleep(9000)：页面早就加载完了还在白等。
 */
async function waitForRendered(send, timeoutMs) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const r = await send("Runtime.evaluate", {
			expression: `!!document.querySelector('.topbar-flow') && !!document.querySelector('.statusbar')`,
			returnByValue: true,
		});
		if (r?.result?.value === true) return Date.now() - t0;
		await sleep(150);
	}
	return -1;
}

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
	for (let i = 0; i < 120 && !target; i++) {
		await sleep(150);
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
		const waited = await waitForRendered(send, 25000);
		console.log(`渲染就绪：${waited >= 0 ? waited + "ms" : "超时"}`);
	} else {
		const waited = await waitForRendered(send, 25000);
		console.log(`渲染就绪：${waited >= 0 ? waited + "ms" : "超时"}`);
	}

	const probe = `(async () => {
		// 插件状态栏可能比首屏晚一点注入，轮询 200ms×40（最多 8s），就绪即走。
		for (let i = 0; i < 40; i++) {
			if (document.getElementById('codex-usage-statusbar')) break;
			await new Promise(r => setTimeout(r, 200));
		}
		const costItem = [...document.querySelectorAll('.statusbar .status-item')].find(n => /累计成本|Cumulative cost/i.test(n.getAttribute('title') || ''));
		window.__piWebUiHost?.setView?.('plugin:codex-usage');
		// 等插件视图渲染出内容即可，不再固定等 1.2s。
		for (let i = 0; i < 30; i++) {
			if (document.querySelector('.cu-meta')) break;
			await new Promise(r => setTimeout(r, 100));
		}
		return JSON.stringify({
			pluginTab: [...document.querySelectorAll('.plugin-tab')].map(n => n.innerText.replace(/\\n/g, ' ')),
			topbarItems: [...document.querySelectorAll('.topbar-flow > *')]
				.filter(n => n.offsetWidth || n.offsetHeight)
				.map(n => ({
					text: (n.innerText || '').replace(/\\s+/g, ' ').trim(),
					tip: n.getAttribute('data-tip') || n.getAttribute('title') || '',
					cls: (n.className || '').toString()
				})),
			statusBarSummary: document.getElementById('codex-usage-statusbar')?.textContent ?? null,
			// 官方 bottombar 槽位渲染出来的条目（0.90.0+）：宿主把 badge 类条目渲染成
			// <button class="status-action">，靠 title 里的中文描述认出来。
			slotBar: (() => {
				const btn = [...document.querySelectorAll('.statusbar .status-action')]
					.find(n => /订阅额度|按量成本|Codex 订阅|5h\\s*已用|每周\\s*已用/.test((n.getAttribute('title') || '') + ' ' + (n.textContent || '')));
				return btn ? { text: (btn.innerText || '').trim(), title: btn.getAttribute('title') || '' } : null;
			})(),
			nativeCostHidden: costItem ? costItem.style.display === 'none' : null,
			// 状态栏实际子节点（排查「条目看不见 / 显示两次」时最直接）：
			// 0.90.0 起插件应走官方 bottombar 槽位，这里能看到它的 data-item-id。
			barItems: [...document.querySelectorAll('.statusbar > *')].map(n => ({
				tag: n.tagName.toLowerCase(),
				id: n.id || null,
				itemId: n.getAttribute('data-item-id') || n.dataset?.itemId || null,
				cls: (n.className || '').toString().slice(0, 40),
				text: (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
				visible: !!(n.offsetWidth || n.offsetHeight),
				costTitle: n.getAttribute('title') || null
			})),
			meta: document.querySelector('.cu-meta')?.innerText ?? null,
			barHtml: (document.querySelector('.statusbar')?.innerHTML ?? '').slice(0, 2200)
		});
	})()`;
	const res = await send("Runtime.evaluate", { expression: probe, awaitPromise: true, returnByValue: true });
	const data = res?.result?.value ? JSON.parse(res.result.value) : null;

	console.log("\n=== codex-usage 自检结果 ===");
	if (!data) {
		console.log("✗ 页面探测失败");
	} else {
		console.log("插件 tab：", data.pluginTab.join(" / ") || "（未出现）");
		console.log("顶部独立入口：", (data.topbarItems || []).map(x => x.text || x.tip).filter(Boolean).join(" / ") || "（未出现）");
		console.log("状态栏摘要：", data.statusBarSummary ?? (data.slotBar ? data.slotBar.text + "（官方 bottombar 槽位）" : "（未注入）"));
		if (data.slotBar) console.log("  悬停提示：", data.slotBar.title);
		console.log("原生成本项已隐藏：", data.nativeCostHidden);
		console.log("插件元数据：\n" + (data.meta ?? "（读不到）").split("\n").map((l) => "  " + l).join("\n"));
		if (Array.isArray(data.barItems)) {
			console.log("状态栏子节点 " + data.barItems.length + " 个：");
			for (const b of data.barItems) {
				console.log(
					"  " + (b.visible ? "可见" : "隐藏") + "  <" + b.tag + (b.id ? " id=" + b.id : "") + (b.itemId ? " item=" + b.itemId : "") + ">" +
						"  text=\"" + b.text + "\"" + (b.costTitle ? "  title=\"" + b.costTitle.slice(0, 30) + "\"" : ""),
				);
			}
		}
		if (data.barHtml) {
			console.log("状态栏 HTML：");
			for (const line of data.barHtml.replace(/></g, ">\n<").split("\n")) console.log("  " + line);
		}
		const topbarText = (data.topbarItems || []).map(x => `${x.text} ${x.tip}`).join(' ');
		const topbarOk = ['声音', '中文', '主题', 'v0.94.1', 'GitHub'].every(x => topbarText.includes(x));
		const ok = Boolean(data.statusBarSummary || data.slotBar) && data.pluginTab.length > 0 && topbarOk;
		console.log("原生菜单项已提升到顶栏：", topbarOk);
		console.log(ok ? "\n✓ 插件及顶栏按钮工作正常" : "\n✗ 自检未通过（看上面的空项）");
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
