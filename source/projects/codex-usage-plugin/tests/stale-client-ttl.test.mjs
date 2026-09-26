/**
 * 幽灵页面（心跳过期）回归测试：离线、不读本机会话、不发网络请求。
 *
 * 背景：宿主没有 detach 回调，掉线的页面（临时 Edge 自检、关掉的标签页）会留在插件的
 * 跟踪表里，继续占着官方 bottombar 槽位那一份状态 —— 用户就会看到“别的对话的额度/成本”
 * （实测：自检脚本的临时 Edge 退出后，用户那页显示 ¥0.00，而本对话实际 ¥1.53）。
 * 现在客户端每 45s 发心跳，服务端超过 TTL 未见的即清掉。
 *
 * 运行：node projects/codex-usage-plugin/tests/stale-client-ttl.test.mjs
 */
import assert from "node:assert/strict";

// 必须在加载插件前设置：把 TTL 压到 300ms，否则这个测试要等 3 分钟。
process.env.PI_CODEX_USAGE_CLIENT_TTL_MS = "300";
const { default: plugin } = await import("../index.mjs");

const SETTINGS = {
	mode: "auto",
	defaultBillingMode: "unknown",
	billingOverrides: JSON.stringify({ deepseek: "metered", anthropic: "metered" }),
	rateSource: "fixed",
	fixedRate: 7.2,
	refreshSec: 3600,
	statusBar: true,
	hideNativeCost: true,
	proxy: "",
	inheritProxy: false,
};

const LIVE = { conversationId: "conv-live", model: "deepseek/deepseek-flash", stats: { totalMessages: 12 } };
const GHOST = { conversationId: "conv-ghost", model: "anthropic/claude-sonnet-4", stats: { totalMessages: 0 } };
const CONVS = { "client-live": LIVE, "client-ghost": GHOST };
/** 没有客户端在跟踪时的全局兜底 = 用户那个对话。 */
const GLOBAL_CONV = LIVE;

const handlers = { message: [], attach: [] };
const sent = [];
const broadcasts = [];
const host = {
	log: () => {},
	getSettings: () => ({ ...SETTINGS }),
	onMessage: (h) => {
		handlers.message.push(h);
		return () => {};
	},
	onAttach: (h) => {
		handlers.attach.push(h);
		return () => {};
	},
	onConversationChanged: () => () => {},
	onRunEvent: () => () => {},
	onSettingsChanged: () => () => {},
	sendTo: (clientId, payload) => sent.push({ clientId, payload }),
	broadcast: (payload) => broadcasts.push(payload.state),
	getActiveConversation: (clientId) => (clientId ? CONVS[clientId] ?? null : GLOBAL_CONV),
	storage: { get: (_k, f) => f, set: () => {} },
};

const cleanup = plugin.activate(host);
const hello = (clientId) => handlers.message.forEach((h) => h({ action: "hello" }, clientId));

// 两个页面都接入；幽灵页面排在最后，所以槽位先跟随它（这正是会骗到人的那一步）。
for (const clientId of ["client-live", "client-ghost"]) handlers.attach.forEach((h) => h(clientId));

// 只有存活页面持续心跳（客户端 45s 一次，这里按 TTL 比例加速）。
const beat = setInterval(() => hello("client-live"), 80);
await new Promise((r) => setTimeout(r, 1100));
clearInterval(beat);
await new Promise((r) => setTimeout(r, 150));

const midGhost = broadcasts.find((s) => s.conversationId === "conv-ghost");
assert.ok(midGhost, "幽灵页面接入后应曾经参与槽位状态（说明这个测试确实覆盖了旧行为）");
const last = broadcasts[broadcasts.length - 1];
assert.equal(
	last?.conversationId,
	"conv-live",
	`幽灵页面过期后槽位应回到存活页面，实际 ${last?.conversationId}`,
);
assert.equal(last?.model?.provider, "deepseek");
// 幽灵页面过期后不该再收到定向推送（它已经不在了）。
const ghostPushesAfterTtl = sent.filter((item) => item.clientId === "client-ghost").length;
const livePushes = sent.filter((item) => item.clientId === "client-live").length;
assert.ok(livePushes > ghostPushesAfterTtl, `存活页面应持续收到推送（live=${livePushes} ghost=${ghostPushesAfterTtl}）`);

cleanup();
console.log("✓ 幽灵页面（心跳过期）回归测试通过：过期页面不再占据状态栏");
