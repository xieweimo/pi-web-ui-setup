/**
 * 通用额度/计费插件手工测试。
 *
 * 覆盖：
 *   1. Codex OAuth 订阅 + 真实额度接口；
 *   2. 多 provider API 按量汇总；
 *   3. 手工声明的非 Codex 订阅（无额度 adapter，也必须排除理论目录价）；
 *   4. 预付积分中转；
 *   5. 未知中转站不得冒充“真实按量账单”。
 */
import plugin from "../index.mjs";

const BASE_SETTINGS = {
	mode: "auto",
	defaultBillingMode: "unknown",
	billingOverrides: "",
	rateSource: "fixed",
	fixedRate: 7.2,
	refreshSec: 3600,
	statusBar: true,
	hideNativeCost: true,
	proxy: "",
	inheritProxy: false,
};

function makeHost(conv, settings) {
	const seen = [];
	const host = {
		log: (...a) => console.log("[plugin]", ...a),
		getSettings: () => ({ ...settings }),
		onMessage: () => () => {},
		onAttach: () => () => {},
		onConversationChanged: () => () => {},
		onRunEvent: () => () => {},
		onSettingsChanged: () => () => {},
		sendTo: () => {},
		broadcast: (p) => seen.push(p.state),
		getActiveConversation: () => ({ stats: { totalMessages: conv.messages?.length ?? 0 }, ...conv }),
		storage: { get: (_k, f) => f, set: () => {} },
	};
	return { host, seen };
}

async function run(label, conv, patch = {}, waitMs = 700) {
	const settings = { ...BASE_SETTINGS, ...patch };
	const { host, seen } = makeHost(conv, settings);
	const cleanup = plugin.activate(host);
	await new Promise((r) => setTimeout(r, waitMs));
	cleanup();
	const state = seen[seen.length - 1];
	console.log(`\n===== ${label} =====`);
	console.log(JSON.stringify(state, null, 2));
	return state;
}

const codex = await run(
	"Codex OAuth 订阅",
	{
		model: "openai-codex/gpt-5.6-sol",
		messages: [{ role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", usageCost: 2.5 }],
	},
	{},
	6000,
);
if (codex?.kind !== "subscription" || codex.adapter !== "codex") {
	throw new Error(`期望 Codex subscription adapter，实际 ${codex?.kind}/${codex?.adapter}`);
}
if (!codex.primary && !codex.secondary) throw new Error("没有拿到 Codex 用量窗口");
if (codex.usd !== 0 || !(codex.subscriptionTheoreticalUsd > 0)) throw new Error("Codex 理论目录价没有正确排除");

const metered = await run(
	"多 provider API 按量",
	{
		model: "deepseek/deepseek-flash",
		messages: [
			{ role: "assistant", provider: "deepseek", model: "deepseek-flash", usageCost: 1.2 },
			{ role: "assistant", provider: "anthropic", model: "claude-sonnet-4", usageCost: 2.3 },
		],
	},
	{ billingOverrides: '{"anthropic":"metered"}' },
);
if (metered?.kind !== "cost") throw new Error("按量场景没有进入 cost");
if (Math.abs(metered.usd - 3.5) > 1e-9) throw new Error(`多 provider 汇总错误：${metered.usd}`);
if (metered.providers?.length !== 2) throw new Error("provider 明细数量错误");
const deepseek = metered.providers.find((row) => row.provider === "deepseek");
if (deepseek?.mode !== "metered" || deepseek.billingSource !== "official-api-key" || deepseek.billingConfidence !== "high") {
	throw new Error("DeepSeek 官方 API key 没有被自动识别为高置信度按量计费");
}

const subscription = await run(
	"非 Codex 订阅（无额度 adapter）",
	{
		model: "anthropic/claude-sonnet-4",
		messages: [{ role: "assistant", provider: "anthropic", model: "claude-sonnet-4", usageCost: 4.2 }],
	},
	{ billingOverrides: '{"anthropic":{"mode":"subscription","label":"Claude Max"}}' },
);
if (subscription?.kind !== "subscription" || subscription.quotaAvailable !== false) {
	throw new Error("手工订阅没有进入无 adapter 的 subscription 状态");
}
if (subscription.usd !== 0 || Math.abs(subscription.subscriptionTheoreticalUsd - 4.2) > 1e-9) {
	throw new Error("手工订阅目录价没有排除");
}

const prepaid = await run(
	"预付积分中转",
	{
		model: "relay/model-x",
		messages: [{ role: "assistant", provider: "relay", model: "model-x", usageCost: 0.75 }],
	},
	{ billingOverrides: '{"relay":{"mode":"prepaid","label":"自建中转余额"}}' },
);
if (prepaid.providers?.[0]?.mode !== "prepaid" || Math.abs(prepaid.cny - 5.4) > 1e-9) {
	throw new Error("预付积分分类或汇率换算错误");
}

const unknown = await run("未知中转", {
	model: "mystery/model-y",
	messages: [{ role: "assistant", provider: "mystery", model: "model-y", usageCost: 0.5 }],
});
if (unknown.providers?.[0]?.mode !== "unknown") throw new Error("未知 provider 被错误认定为明确计费方式");
if (unknown.providers?.[0]?.billingConfidence !== "low") throw new Error("未知 provider 置信度错误");

console.log("\n✓ 全部通过");
