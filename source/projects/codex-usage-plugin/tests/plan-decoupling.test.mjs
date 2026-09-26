/**
 * 「看板/规划操作不得影响额度成本」解耦回归测试（离线）。
 *
 * 背景：用户反馈「改看板的时候老是把额度清零了」。实际核查结论是**没有代码耦合**：
 *   - 插件不引用任何看板/plan 代码（`state.plan` 只是 Codex 套餐名）；
 *   - 看板补丁只改 web bundle / dangling-tools.js，不碰插件文件与插件数据；
 *   - 看板相关的条目（custom / custom_message / context_edit / marker）都不带 usage，
 *     对成本账本贡献为 0，也不改变 provider 归属。
 * 真正让额度「看起来被清零」的是：每轮看板补丁都伴随一次 pi-web-ui 重启，插件内存态被清空，
 * 状态栏回落到「全局最近活跃对话」（常是空对话 → ¥0.00）。那部分已在按页面隔离 +
 * 心跳/TTL 里修掉；这个测试锁死「看板操作不会改成本账本」这一条。
 *
 * 运行：node projects/codex-usage-plugin/tests/plan-decoupling.test.mjs
 */
import assert from "node:assert/strict";
import { costBreakdownFromRows } from "../index.mjs";

const CFG = { defaultBillingMode: "unknown", billingOverrides: JSON.stringify({ deepseek: "metered" }) };

/** 一条 deepseek 已结算调用。 */
const assistant = (id, parentId, usd) => ({
	type: "message",
	id,
	parentId,
	message: { role: "assistant", provider: "deepseek", model: "deepseek-flash", usage: { cost: { total: usd } } },
});

const base = [
	{ type: "model_change", id: "root", parentId: null, provider: "deepseek", modelId: "deepseek-flash" },
	assistant("a1", "root", 1),
	assistant("a2", "a1", 2),
	assistant("a3", "a2", 3),
];

/** 看板/规划/标记类条目：都没有 usage。两种真实写法都要覆盖：
 *  ① 夹在两条回复之间（看板更新）；② 追在分支末尾（清空/最后的标记）。 */
const planNoise = [
	{ type: "custom", id: "p1", parentId: null, customType: "plan", data: { steps: [{ id: "1", title: "查根因", status: "in_progress" }] } },
	{ type: "custom", id: "p2", parentId: null, customType: "plan", data: { steps: [{ id: "1", title: "查根因", status: "done" }] } },
	{ type: "custom_message", id: "p3", parentId: null, customType: "plan-marker", content: "[plan] 1/1 done" },
	{ type: "context_edit", id: "p4", parentId: null, targetId: "p2", replacement: null },
];

/** 把噪音链进主干：root → a1 → [p1..p4] → a2 → a3。 */
const inline = [
	{ type: "model_change", id: "root", parentId: null, provider: "deepseek", modelId: "deepseek-flash" },
	assistant("a1", "root", 1),
	{ ...planNoise[0], parentId: "a1" },
	{ ...planNoise[1], parentId: "p1" },
	{ ...planNoise[2], parentId: "p2" },
	{ ...planNoise[3], parentId: "p3" },
	assistant("a2", "p4", 2),
	assistant("a3", "a2", 3),
];

const plain = costBreakdownFromRows(base, CFG);
const withPlan = costBreakdownFromRows(inline, CFG);

assert.equal(plain.usd, 6);
assert.equal(withPlan.usd, plain.usd, "插入看板/规划条目后按量成本不得变化");
assert.equal(withPlan.meteredMessages, plain.meteredMessages, "计入的按量调用次数不得变化");
assert.equal(withPlan.auxiliaryCalls, plain.auxiliaryCalls, "辅助调用次数不得变化（看板条目不是 API 调用）");
assert.equal(withPlan.missingCostMessages, plain.missingCostMessages, "不得把看板条目算成缺成本的 assistant 消息");
assert.deepEqual(withPlan.providers, plain.providers, "provider 归属与明细必须完全一致");

// 看板清空（清空标记追在分支末尾，且最后一条仍是普通消息之后）也不能让成本归零。
const cleared = costBreakdownFromRows(
	[...base, { ...planNoise[0], id: "clear", parentId: "a3", customType: "plan-clear" }],
	CFG,
);
assert.equal(cleared.usd, 6, "看板清空后活动分支仍要覆盖全部回复，成本不得归零");
assert.deepEqual(cleared.providers, plain.providers, "看板清空后 provider 明细也不得变化");

// compaction 是真实 API 调用：必须继续计入（唯一会带 usage 的规划类条目）。
const withCompaction = costBreakdownFromRows(
	[...base, { type: "compaction", id: "c1", parentId: "a3", usage: { cost: { total: 0.5 } } }],
	CFG,
);
assert.equal(withCompaction.usd, 6.5, "compaction 是真实 API 调用，其成本必须计入（6 + 0.5）");
assert.equal(withCompaction.meteredMessages, plain.meteredMessages, "compaction 不得被算成一条对话回复");
assert.equal(withCompaction.auxiliaryCalls, 1, "compaction 必须计入辅助调用");

console.log("✓ 看板/规划操作与额度成本解耦测试通过（看板条目不影响成本账本）");
