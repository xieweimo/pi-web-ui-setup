#!/usr/bin/env node
/** 真实网络冒烟测试：不使用固定 sleep；只根据状态路由报告结果。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../index.mjs";

function makeHost(proxy) {
	const badges = [];
	const notices = [];
	let stateRoute;
	const host = {
		getSettings: () => ({ intervalSec: 600, timeoutMs: 8000, failThreshold: 1, proxy }),
		onSettingsChanged: () => () => {},
		ui: { update: (_id, value) => badges.push(value) },
		notify: (level, zh) => notices.push({ level, zh }),
		log: () => {},
		route: (_method, _path, cb) => { stateRoute = cb; return () => {}; },
	};
	return { host, badges, notices, state: () => { let result; stateRoute({}, { json: (value) => { result = value; } }); return result; } };
}
async function waitState(view, limitMs = 22000) {
	const start = Date.now();
	while (Date.now() - start < limitMs) {
		const state = view.state();
		if (state.state !== "loading") return state;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw Error(`探测超时（${limitMs}ms）：没有完成首次状态切换`);
}

let realProxy = "";
try {
	realProxy = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8")).httpProxy || "";
} catch { /* 没有真实代理则跳过该场景 */ }
if (realProxy) {
	const view = makeHost(realProxy);
	const stop = plugin.activate(view.host);
	try {
		const state = await waitState(view);
		console.log(`真实代理首探状态：${state.state}（网络结果不作为代码正确性的硬性断言）`);
		assert.ok(view.badges.length > 0);
	} finally { stop(); }
}
{
	const view = makeHost("http://127.0.0.1:1");
	const stop = plugin.activate(view.host);
	try {
		const state = await waitState(view);
		assert.equal(state.state, "down");
		assert.match(view.badges.at(-1).label, /^⚠/);
		assert.equal(view.notices.length, 1);
		console.log("✓ 拒绝连接的代理 → 链路不可用且仅通知一次");
	} finally { stop(); }
}
{
	const prevSettings = process.env.PI_AGENT_SETTINGS_FILE;
	const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_SETTINGS_FILE = path.join(os.tmpdir(), "proxy-health-no-such-settings.json");
	for (const key of keys) delete process.env[key];
	try {
		const view = makeHost("");
		const stop = plugin.activate(view.host);
		try {
			const state = await waitState(view);
			assert.ok(["ok", "direct"].includes(state.state), `无代理直连结果异常：${state.state}`);
			console.log(`✓ 无代理配置 → 测试直连（${state.state}），不预设地域结论`);
		} finally { stop(); }
	} finally {
		if (prevSettings === undefined) delete process.env.PI_AGENT_SETTINGS_FILE;
		else process.env.PI_AGENT_SETTINGS_FILE = prevSettings;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
console.log("✓ 真实网络冒烟完成");
