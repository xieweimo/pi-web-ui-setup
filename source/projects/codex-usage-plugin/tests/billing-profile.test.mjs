/**
 * billingProfile 识别引擎单元测试。
 *
 * 通过 inject 注入认证与 endpoint 元数据，不依赖本机真实配置。
 * 运行：node projects/codex-usage-plugin/tests/billing-profile.test.mjs
 */
import assert from "node:assert/strict";
import { billingProfile, barText, barHint, providerCostSplit, currentModelCostRow } from "../index.mjs";

const CFG = { billingOverrides: "", defaultBillingMode: "unknown" };
const api = (baseUrl, type = "api_key") => ({
	modelMeta: { baseUrl, api: "openai-completions" },
	authMeta: { type, hasKey: type === "api_key", hasAccess: type === "oauth" },
});

// ---- 官方按量 endpoint（api_key，高置信度） ----
const officialCases = [
	["openai", "https://api.openai.com/v1"],
	["anthropic", "https://api.anthropic.com"],
	["google", "https://generativelanguage.googleapis.com"],
	["deepseek", "https://api.deepseek.com"],
	["xiaomi", "https://api.xiaomimimo.com/v1"],
	["moonshot", "https://api.moonshot.cn/v1"],
	["kimi", "https://api.kimi.com"],
	["zai", "https://open.bigmodel.cn/api/paas/v4"],
	["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
	["doubao", "https://ark.cn-beijing.volces.com/api/v3"],
	["minimax", "https://api.minimax.chat/v1"],
	["siliconflow", "https://api.siliconflow.cn/v1"],
	["xai", "https://api.x.ai/v1"],
	["groq", "https://api.groq.com/openai/v1"],
	["perplexity", "https://api.perplexity.ai"],
	["together", "https://api.together.xyz/v1"],
	["fireworks", "https://api.fireworks.ai/inference/v1"],
];
for (const [provider, baseUrl] of officialCases) {
	const profile = billingProfile(provider, "m", CFG, api(baseUrl));
	assert.equal(profile.mode, "metered", `${provider} 应为按量`);
	assert.equal(profile.confidence, "high", `${provider} 官方 key 应为高置信度`);
	assert.equal(profile.source, "official-api-key");
}

// ---- 订阅类 ----
const subCases = [
	// GLM Coding Plan：/coding/ 路径
	api("https://open.bigmodel.cn/api/coding/paas/v4"),
	// Kimi for Coding
	{ modelMeta: { baseUrl: "https://api.kimi.com/coding", api: "" }, authMeta: { type: "api_key", hasKey: true } },
	// provider 名含 coding-plan
	{ modelMeta: { baseUrl: "", api: "" }, authMeta: { type: "api_key", hasKey: true }, provider: "kimi-coding-plan" },
	// OAuth（Claude Max / Gemini CLI / Qwen OAuth）
	{ modelMeta: { baseUrl: "https://claude.ai/api", api: "" }, authMeta: { type: "oauth", hasKey: false, hasAccess: true } },
	{ modelMeta: { baseUrl: "https://chatgpt.com/backend-api", api: "" }, authMeta: { type: "oauth", hasKey: false, hasAccess: true } },
];
for (const [i, inject] of subCases.entries()) {
	const provider = inject.provider ?? "some-provider";
	const profile = billingProfile(provider, "m", CFG, inject);
	assert.equal(profile.mode, "subscription", `订阅场景 ${i} 失败：${provider}`);
}
assert.equal(billingProfile("x", "y", CFG, subCases[0]).source, "known-coding-plan");
assert.equal(billingProfile("x", "y", CFG, subCases[3]).source, "oauth");

// ---- 预付积分 ----
const or = billingProfile("openrouter", "m", CFG, api("https://openrouter.ai/api/v1"));
assert.equal(or.mode, "prepaid");
assert.equal(or.source, "known-prepaid");
const orFree = billingProfile("openrouter", "qwen/qwen3.8-27b:free", CFG, api("https://openrouter.ai/api/v1"));
assert.equal(orFree.mode, "free");
assert.equal(orFree.source, "openrouter-free");

// ---- 免费/本地 ----
const local = billingProfile("ollama", "m", CFG, {
	modelMeta: { baseUrl: "http://127.0.0.1:11434/v1", api: "" },
	authMeta: { type: "", hasKey: false, hasAccess: false },
});
assert.equal(local.mode, "free");
assert.equal(local.confidence, "high");

// ---- 中转站 / 未知 ----
const relay = billingProfile("my-relay", "m", CFG, api("https://relay.example.com/v1"));
assert.equal(relay.mode, "unknown");
assert.equal(relay.confidence, "low");
assert.match(relay.note, /中转 endpoint/);

// 官方厂商名但挂在中转域名下：不得凭名字判定为按量
const relayed = billingProfile("deepseek", "m", CFG, api("https://relay.example.com/v1"));
assert.equal(relayed.mode, "unknown", "官方名字挂中转域名不得误判");

// 名字白名单仅在无 baseUrl 反证时生效（中置信度）
const named = billingProfile("moonshot", "m", CFG, { modelMeta: { baseUrl: "", api: "" }, authMeta: { type: "api_key", hasKey: true } });
assert.equal(named.mode, "metered");
assert.equal(named.source, "known-provider");
assert.equal(named.confidence, "medium");

// 无任何信号：跟随 defaultBillingMode=unknown
const blank = billingProfile("mystery", "m", CFG, { modelMeta: { baseUrl: "", api: "" }, authMeta: { type: "", hasKey: false, hasAccess: false } });
assert.equal(blank.mode, "unknown");

// ---- 用户规则优先级 ----
const rules = {
	billingOverrides: '{"my-relay/claude":"subscription","my-relay":{"mode":"prepaid","label":"中转余额"},"deepseek":"hybrid"}',
	defaultBillingMode: "unknown",
};
assert.equal(billingProfile("my-relay", "claude", rules, api("https://relay.example.com")).mode, "subscription");
assert.equal(billingProfile("my-relay", "gpt", rules, api("https://relay.example.com")).mode, "prepaid");
assert.equal(billingProfile("my-relay", "gpt", rules, api("https://relay.example.com")).label, "中转余额");
assert.equal(billingProfile("deepseek", "m", rules, api("https://api.deepseek.com")).mode, "hybrid");
assert.equal(billingProfile("deepseek", "m", rules, api("https://api.deepseek.com")).confidence, "explicit");

// Codex 内置 adapter 不受普通规则影响
const codex = billingProfile("openai-codex", "gpt-5.6-sol", CFG, { modelMeta: { baseUrl: "", api: "" }, authMeta: { type: "", hasKey: false, hasAccess: false } });
assert.equal(codex.mode, "subscription");
assert.equal(codex.source, "builtin-adapter");

// ---- 状态栏摘要跟随当前 provider ----
// GLM Coding Plan：订阅但无窗口数据，不得显示成 Codex
const glmSub = {
	kind: "subscription",
	provider: "zai-coding-cn",
	model: { provider: "zai-coding-cn", model: "glm-5.3-flash" },
	quotaAvailable: false,
};
assert.equal(barText(glmSub), "⚡ zai-coding-cn");
assert.match(barHint(glmSub), /zai-coding-cn · 已识别为订阅/);
assert.doesNotMatch(barText(glmSub), /Codex/);
// Codex 订阅有窗口：保留窗口百分比并带 provider 前缀
const codexSub = {
	kind: "subscription",
	provider: "openai-codex",
	primary: { usedPercent: 61, windowSeconds: 18000 },
	secondary: { usedPercent: 92, windowSeconds: 604800 },
	resets: 1,
};
assert.equal(barText(codexSub), "⚡ openai-codex · 5h 61% · 每周 92% · 1 reset");
// 按量：人民币成本
assert.equal(barText({ kind: "cost", cny: 3.6 }), "⚡ ¥3.60");
// 未知 provider 订阅也不冒充 Codex
assert.equal(barText({ kind: "subscription", provider: "mystery" }), "⚡ mystery");

// ---- 总计不能被误读成“当前模型花了这么多”：拆分与当前模型必须分开显示 ----
const costState = {
	kind: "cost",
	rate: 6.72,
	rateSource: "live",
	usd: 0.687,
	cny: 4.62,
	model: { provider: "xiaomi", model: "mimo-v2.6-flash" },
	providers: [
		{ provider: "deepseek", mode: "metered", usd: 0.6578, cny: 4.42, models: [{ model: "deepseek-flash", mode: "metered", usd: 0.6578, cny: 4.42, calls: 173 }] },
		{ provider: "xiaomi", mode: "metered", usd: 0.0293, cny: 0.2, models: [{ model: "mimo-v2.6-flash", mode: "metered", usd: 0.0293, cny: 0.2, calls: 5 }] },
		{ provider: "openai-codex", mode: "subscription", usd: 0, cny: 0, models: [{ model: "gpt-5.6-terra", mode: "subscription", usd: 0, cny: 0, calls: 104 }] },
	],
};
const hint = barHint(costState);
assert.match(hint, /本会话 API 按量总计/);
assert.match(hint, /deepseek ¥4\.42/);
assert.match(hint, /xiaomi ¥0\.20/);
assert.match(hint, /当前模型 xiaomi\/mimo-v2\.6-flash：¥0\.20（5 次）/);
assert.doesNotMatch(hint, /openai-codex/);
assert.equal(providerCostSplit(costState).length, 2, "订阅行不得进按量拆分");
const cur = currentModelCostRow(costState);
assert.equal(cur.cny, 0.2);
assert.equal(cur.calls, 5);
assert.equal(currentModelCostRow({ kind: "cost", model: { provider: "x", model: "m" }, providers: [] }), null);
assert.equal(barText(costState), "⚡ ¥4.62");

console.log("✓ billingProfile 识别引擎单元测试全部通过");
