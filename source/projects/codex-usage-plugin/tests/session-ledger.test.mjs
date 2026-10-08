/**
 * 完整会话账本回归测试。
 * 不读取本机会话、不调用网络：覆盖活动分支、辅助调用、缺失成本与模型级规则冲突。
 * 运行：node projects/codex-usage-plugin/tests/session-ledger.test.mjs
 */
import assert from "node:assert/strict";
import { costBreakdownFromRows } from "../index.mjs";

const CFG = {
	defaultBillingMode: "unknown",
	billingOverrides: JSON.stringify({
		deepseek: "metered",
		anthropic: "metered",
		"relay/model-a": "metered",
		"relay/model-b": "subscription",
	}),
};

// 最后一条叶子是当前分支；old 是从 a 分出的废弃分支，绝不能被累计。
const rows = [
	{ type: "session", id: "session" },
	null, // 模拟 JSONL 损坏行解析后的过滤结果
	{ type: "model_change", id: "root", provider: "deepseek", modelId: "chat", parentId: null },
	{ type: "message", id: "a", parentId: "root", message: { role: "assistant", usage: { cost: { total: 1.2 } } } },
	{ type: "message", id: "old", parentId: "a", message: { role: "assistant", usage: { cost: { total: 99 } } } },
	{ type: "model_change", id: "switch", parentId: "a", provider: "anthropic", modelId: "sonnet" },
	{ type: "message", id: "tool", parentId: "switch", message: { role: "toolResult", usage: { cost: { total: 0.3 } } } },
	{ type: "compaction", id: "compact", parentId: "tool", usage: { cost: { total: 0.2 } } },
	{ type: "branch_summary", id: "summary", parentId: "compact", usage: { cost: { total: 0.1 } } },
	{ type: "message", id: "missing", parentId: "summary", message: { role: "assistant" } },
	{ type: "message", id: "leaf", parentId: "missing", message: { role: "assistant", usage: { cost: { total: 0.4 } } } },
];

const book = costBreakdownFromRows(rows, CFG);
assert.equal(book.costSource, "session-ledger");
assert.equal(book.providers.length, 2);
assert.equal(book.usd, 2.2, "必须排除废弃分支的 99 美元");
assert.equal(book.auxiliaryCalls, 3, "toolResult、compaction、branch_summary 均应计入辅助调用");
assert.equal(book.missingCostMessages, 1, "缺 usage.cost.total 的 assistant 应被统计");
assert.equal(book.providers.find((row) => row.provider === "deepseek")?.usd, 1.2);
assert.equal(book.providers.find((row) => row.provider === "anthropic")?.usd, 1.0);
const deepseekModel = book.providers.find((row) => row.provider === "deepseek")?.models.find((row) => row.model === "chat");
assert.equal(deepseekModel?.messages, 1, "模型明细必须连续累计该模型调用");
assert.equal(deepseekModel?.usd, 1.2, "模型金额必须与 provider 汇总一致");
assert.equal(deepseekModel?.usageCostCalls, 1, "有 usage.cost.total 时必须优先使用它");

// 同一 provider 命中彼此冲突的 model 级计费规则时，不能把聚合金额称为真实账单。
const mixed = costBreakdownFromRows(
	[
		{ type: "model_change", id: "r", provider: "relay", modelId: "model-a" },
		{ type: "message", id: "a", parentId: "r", message: { role: "assistant", usage: { cost: { total: 1 } } } },
		{ type: "model_change", id: "b", parentId: "a", provider: "relay", modelId: "model-b" },
		{ type: "message", id: "c", parentId: "b", message: { role: "assistant", usage: { cost: { total: 2 } } } },
	],
	CFG,
);
assert.equal(mixed.providers[0].mode, "unknown");
assert.match(mixed.providers[0].billingNote, /不同计费规则/);

// usage.cost.total 缺失时，DeepSeek Flash 才按已核实官方 token 价回退；
// 1M 输入 token × $0.30/M = $0.30，且必须标注来源，不能冒充响应成本。
const priced = costBreakdownFromRows(
	[
		{ type: "model_change", id: "r", provider: "deepseek", modelId: "deepseek-flash" },
		{ type: "message", id: "m", parentId: "r", message: { role: "assistant", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } },
	],
	CFG,
);
assert.equal(priced.usd, 0.3);
const flash = priced.providers[0].models[0];
assert.equal(flash.officialPriceCalls, 1);
assert.equal(flash.usageCostCalls, 0);
assert.equal(flash.inputTokens, 1_000_000);
assert.equal(flash.usdPerMillionTokens, 0.3);

// Xiaomi MiMo V2.6 Flash 同样有已核实的官方实时 API 价：1M 未命中输入 × $0.14/M。
const xiaomiPriced = costBreakdownFromRows(
	[
		{ type: "model_change", id: "r", provider: "xiaomi", modelId: "mimo-v2.6-flash" },
		{ type: "message", id: "m", parentId: "r", message: { role: "assistant", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } },
	],
	CFG,
);
assert.equal(xiaomiPriced.usd, 0.14);
assert.equal(xiaomiPriced.providers[0].models[0].officialPriceCalls, 1);

// 同一对话切模型、再切 API 提供商：旧模型金额必须保留在自己的行，且 provider 不串账。
const switched = costBreakdownFromRows(
	[
		{ type: "model_change", id: "r", provider: "deepseek", modelId: "deepseek-flash" },
		{ type: "message", id: "a", parentId: "r", message: { role: "assistant", usage: { cost: { total: 0.1 }, input: 100, output: 10 } } },
		{ type: "model_change", id: "b", parentId: "a", provider: "deepseek", modelId: "deepseek-v4-pro" },
		{ type: "message", id: "c", parentId: "b", message: { role: "assistant", usage: { cost: { total: 0.9 }, input: 200, output: 20 } } },
		{ type: "model_change", id: "d", parentId: "c", provider: "xiaomi", modelId: "mimo-v2.6-flash" },
		{ type: "message", id: "e", parentId: "d", message: { role: "assistant", usage: { cost: { total: 0.2 }, input: 300, output: 30 } } },
	],
	CFG,
);
assert.equal(switched.usd, 1.2);
const switchedDeepSeek = switched.providers.find((row) => row.provider === "deepseek");
assert.equal(switchedDeepSeek.usd, 1.0);
assert.deepEqual(switchedDeepSeek.models.map((row) => [row.model, row.usd]), [["deepseek-v4-pro", 0.9], ["deepseek-flash", 0.1]]);
assert.equal(switched.providers.find((row) => row.provider === "xiaomi").usd, 0.2);

assert.equal(costBreakdownFromRows([], CFG), null);
assert.equal(costBreakdownFromRows([null, { type: "session", id: "s" }], CFG), null);
console.log("✓ 完整会话账本回归测试全部通过");
