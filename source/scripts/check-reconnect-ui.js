#!/usr/bin/env node
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EDGE = [
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find(fs.existsSync);
const args = process.argv.slice(2);
function flag(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const WEB_PORT = Number(flag("port", "5173"));
const CDP_PORT = Number(flag("cdp-port", "9335"));
const OUT = path.resolve(__dirname, "..", "docs", `pi-web-ui-service-control-${WEB_PORT}.png`);
const PROFILE = path.join(os.tmpdir(), `reconnect-ui-check-${process.pid}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadWs() {
	for (const candidate of [
		path.resolve(__dirname, "..", "projects", "pi-web-ui-source", "node_modules", "ws"),
		path.join(process.env.APPDATA || "", "npm", "node_modules", "pi-web-ui", "node_modules", "ws"),
	]) {
		try { return require(candidate); } catch {}
	}
	throw new Error("找不到 ws 模块");
}

async function main() {
	if (!EDGE) throw new Error("找不到 Microsoft Edge");
	const edge = spawn(EDGE, [
		"--headless=new", "--disable-gpu", "--no-first-run",
		`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
		"--window-size=1500,950", `http://localhost:${WEB_PORT}/`,
	], { stdio: "ignore", windowsHide: true });
	try {
		let target;
		for (let i = 0; i < 120 && !target; i++) {
			await sleep(150);
			try {
				const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((response) => response.json());
				target = list.find((item) => item.type === "page" && item.url.includes(String(WEB_PORT)));
			} catch {}
		}
		if (!target) throw new Error("Edge CDP 页面未就绪");
		const WS = loadWs();
		const socket = new WS(target.webSocketDebuggerUrl);
		const pending = new Map();
		let nextId = 0;
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.id && pending.has(message.id)) {
				pending.get(message.id)(message.error ? { __error: message.error } : message.result);
				pending.delete(message.id);
			}
		});
		await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
		const send = (method, params = {}) => new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			socket.send(JSON.stringify({ id, method, params }));
		});
		await send("Runtime.enable");
		await send("Page.enable");
		let contextReady = false;
		for (let i = 0; i < 100; i++) {
			const probe = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
			if (probe?.result?.value) { contextReady = true; break; }
			await sleep(100);
		}
		if (!contextReady) throw new Error("页面执行上下文未就绪");
		const expression = `(async () => {
				for (let i = 0; i < 150; i++) {
					if (window.__piWebUiHost?.setView) break;
					await new Promise(r => setTimeout(r, 100));
				}
				if (window.__piWebUiHost?.setView) window.__piWebUiHost.setView('plugin:reconnect');
				else {
					const entry = [...document.querySelectorAll('button,[role="button"]')].find(n => /重连|Reconnect/.test(n.textContent || n.getAttribute('aria-label') || ''));
					entry?.click();
				}
				for (let i = 0; i < 100; i++) {
					if (document.querySelectorAll('.rc-service').length >= 2) break;
					await new Promise(r => setTimeout(r, 100));
				}
				return {
					title: document.querySelector('.rc h2')?.textContent || '',
					environment: document.querySelector('[data-role="env-detail"]')?.textContent || '',
					services: [...document.querySelectorAll('.rc-service h4')].map(n => n.textContent),
					buttons: [...document.querySelectorAll('.rc button')].map(n => n.textContent),
					text: document.querySelector('.rc')?.innerText || '',
					matrix: [...document.querySelectorAll('.rc-table tr')].map(n => n.innerText.split(String.fromCharCode(10)).join(' | ')),
					impact: [...document.querySelectorAll('.rc-impact')].map(n => n.innerText.split(String.fromCharCode(10)).join(' / ')),
					warnings: [...document.querySelectorAll('.rc-warn')].map(n => n.innerText)
				};
			})()`;
		let result;
		for (let i = 0; i < 20; i++) {
			result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (!result?.__error) break;
			await sleep(250);
		}
		const data = result?.result?.value;
		if (!data) throw new Error(`控制面板未渲染：${JSON.stringify(result)}`);
		if (!data.services.length) throw new Error(`没有渲染出任何服务卡片；探测=${JSON.stringify(data)}`);
		if (!data.buttons.includes("刷新并重新连接")) throw new Error("缺少「刷新并重新连接」");
		if (!data.buttons.includes("完整重启全部服务")) throw new Error("缺少「完整重启全部服务」");
		if (!data.buttons.some((value) => /重启/.test(value))) throw new Error("服务卡片上没有重启按钮");
		if (!data.matrix?.length) throw new Error("缺少影响范围对照表");
		if (!data.impact?.length) throw new Error("服务卡片缺少「会重启什么/不动什么」说明");
		const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
		fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
		console.log(JSON.stringify({ ok: true, title: data.title, environment: data.environment, services: data.services, buttons: data.buttons, matrix: data.matrix, impact: data.impact, screenshot: OUT }, null, 2));
		socket.close();
	} finally {
		try {
			if (process.platform === "win32") execFileSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			else edge.kill("SIGKILL");
		} catch {}
		await sleep(300);
		try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
	}
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
