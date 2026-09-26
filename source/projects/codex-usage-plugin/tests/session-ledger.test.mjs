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

assert.equal(costBreakdownFromRows([], CFG), null);
assert.equal(costBreakdownFromRows([null, { type: "session", id: "s" }], CFG), null);
console.log("✓ 完整会话账本回归测试全部通过");
