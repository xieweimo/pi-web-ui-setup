import assert from "node:assert/strict";
import http from "node:http";
import { createProxyHealthPlugin, probeViaProxy } from "../index.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

async function scenario({ settings = {}, proxy = "http://127.0.0.1:7897", network = async () => 401, direct = async () => 200 } = {}) {
	const badges = [];
	const notices = [];
	const routes = [];
	let onSettings;
	const host = {
		getSettings: () => ({ failThreshold: 1, intervalSec: 600, ...settings }),
		onSettingsChanged: (cb) => { onSettings = cb; return () => {}; },
		ui: { update: (_id, data) => badges.push(data) },
		notify: (level, zh) => notices.push({ level, zh }),
		log: () => {},
		route: (_method, _path, cb) => { routes.push(cb); return () => {}; },
	};
	const stop = createProxyHealthPlugin({ probeNetwork: network, directProbe: direct, resolve: () => proxy }).activate(host);
	await tick();
	const state = () => { let result; routes[0]({}, { json: (value) => { result = value; } }); return result; };
	return { stop, badges, notices, state, change: async (values) => { onSettings(values); await tick(); } };
}

{
	const s = await scenario();
	assert.equal(s.state().state, "ok");
	assert.equal(s.badges.at(-1).label, "🌐");
	assert.equal(s.notices.length, 0, "首次成功不通知");
	s.stop();
}
{
	const calls = [];
	const s = await scenario({ network: async (url) => { calls.push(url); if (url.includes("chatgpt.com")) throw Error("target timeout"); return 204; } });
	assert.equal(s.state().state, "target");
	assert.equal(calls.length, 2);
	assert.match(s.notices[0].zh, /目标站点/);
	assert.doesNotMatch(s.notices[0].zh, /一定|就是.*节点|Clash/);
	await s.change({ intervalSec: 600 });
	assert.equal(s.notices.length, 1, "同状态不重复告警");
	s.stop();
}
{
	const s = await scenario({ network: async () => { throw Error("network timeout"); } });
	assert.equal(s.state().state, "down");
	assert.equal(s.notices[0].level, "warning");
	await s.change({ proxy: "http://localhost:1" });
	assert.equal(s.notices.length, 1);
	s.stop();
}
{
	const s = await scenario({ proxy: "", direct: async () => 200 });
	assert.equal(s.state().state, "ok", "无代理而直连可达不应报警");
	s.stop();
}
{
	const s = await scenario({ proxy: "", direct: async () => { throw Error("direct timeout"); } });
	assert.equal(s.state().state, "direct");
	assert.match(s.notices[0].zh, /直连失败/);
	s.stop();
}
{
	const s = await scenario({ settings: { targetUrl: "http://insecure.example" } });
	assert.equal(s.state().state, "config");
	s.stop();
}
{
	const s = await scenario({ proxy: "socks5://localhost:1080" });
	assert.equal(s.state().state, "config");
	s.stop();
}
{
	const s = await scenario({ settings: { failThreshold: 2 }, network: async () => { throw Error("failed"); } });
	assert.equal(s.state().state, "loading", "第一次失败尚未达到阈值");
	await s.change({ failThreshold: 1 });
	assert.equal(s.state().state, "down");
	s.stop();
}
{
	const server = http.createServer();
	let auth;
	server.on("connect", (req, socket) => { auth = req.headers["proxy-authorization"]; socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = server.address().port;
		await assert.rejects(probeViaProxy("https://example.com/", `http://user:secret@127.0.0.1:${port}`, 1000), /HTTP 407/);
		assert.equal(auth, `Basic ${Buffer.from("user:secret").toString("base64")}`);
	} finally {
		server.close();
	}
}
console.log("✓ 代理健康确定性测试通过（目标/对照、直连、配置、去重、阈值、代理认证）");
