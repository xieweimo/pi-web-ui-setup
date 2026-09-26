/**
 * 按页面隔离的回归测试（离线，不读本机会话、不发网络请求）。
 *
 * 背景：宿主只给「全客户端最近活跃对话」，多标签 / 并行对话 / 子代理下插件会串页
 * （模型选了 DeepSeek，底部却显示 Codex 额度）。插件改成按 clientId 各算一份并定向下发。
 *
 * 运行：node projects/codex-usage-plugin/tests/per-client-state.test.mjs
 */
import assert from "node:assert/strict";
import plugin from "../index.mjs";

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

/** 两个页面：client-1 在看 deepseek 对话，client-2 在看 anthropic 对话。 */
const CONVS = {
	"client-1": {
		conversationId: "conv-deepseek",
		model: "deepseek/deepseek-flash",
		stats: { totalMessages: 163 },
	},
	"client-2": {
		conversationId: "conv-anthropic",
		model: "anthropic/claude-sonnet-4",
		stats: { totalMessages: 4 },
	},
};
/** 宿主「全局最近活跃对话」= client-2 那个（这正是过去会串页的来源）。 */
const GLOBAL_CONV = {
	conversationId: "conv-anthropic",
	model: "anthropic/claude-sonnet-4",
	stats: { totalMessages: 4 },
};

function makeHost() {
	const sent = [];
	const broadcasts = [];
	const handlers = { message: [], attach: [] };
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
		// 补丁后的宿主：传 clientId 取该页面打开的对话。
		getActiveConversation: (clientId) => (clientId ? CONVS[clientId] ?? null : GLOBAL_CONV),
		storage: { get: (_k, f) => f, set: () => {} },
	};
	return { host, sent, broadcasts, handlers };
}

const { host, sent, broadcasts, handlers } = makeHost();
const cleanup = plugin.activate(host);
// 模拟两个浏览器页面接入（宿主会带上各自的 clientId）。
for (const clientId of Object.keys(CONVS)) {
	for (const h of handlers.attach) h(clientId);
}
// 等两轮按页面刷新（汇率取固定值，不触网）。
await new Promise((r) => setTimeout(r, 1200));
cleanup();

const perClient = sent.filter((item) => item.payload?.perClient === true);
const byClient = (id) => perClient.filter((item) => item.clientId === id).map((item) => item.payload.state);
const last = (id) => byClient(id).filter((s) => s.kind !== "loading").pop() ?? byClient(id).pop();

// 两个页面必须各拿到自己那个对话的状态 —— 不能都变成“全局最近活跃”那个。
const mine1 = last("client-1");
const mine2 = last("client-2");
assert.ok(mine1, "client-1 没有收到定向状态");
assert.ok(mine2, "client-2 没有收到定向状态");
assert.equal(mine1.model?.provider, "deepseek", `client-1 收到了别的对话的状态：${mine1.model?.provider}`);
assert.equal(mine1.conversationId, "conv-deepseek");
assert.equal(mine1.totalMessages, 163);
assert.equal(mine1.selectedBillingMode, "metered");
assert.equal(mine2.model?.provider, "anthropic", `client-2 收到了别的对话的状态：${mine2.model?.provider}`);
assert.equal(mine2.conversationId, "conv-anthropic");
assert.equal(mine2.totalMessages, 4);

// 定向下发必须带 perClient 标记，客户端才知道该按页面接管状态栏。
assert.ok(
	perClient.every((item) => item.payload.state?.kind === "loading" || item.payload.perClient === true),
	"定向状态缺少 perClient 标记",
);
// 全局广播（官方槽位兜底）不得冒充成某个页面的状态。
assert.ok(broadcasts.length >= 1, "没有全局广播兜底");
assert.ok(
	broadcasts.every((s) => s.conversationId === "conv-anthropic"),
	`全局兜底广播应跟随最近接入的页面，实际 ${broadcasts.map((s) => s.conversationId).join(",")}`,
);
assert.ok(
	sent.every((item) => item.payload.perClient !== true || item.clientId !== undefined),
	"定向消息缺少 clientId",
);

console.log("✓ 按页面隔离回归测试全部通过（两个页面各拿自己对话的状态）");
