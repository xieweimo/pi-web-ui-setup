/**
 * 会话文件身份回归测试。
 * 复现历史问题：宿主快照里的 conversationId 是 c1/c4 一类短内存 id，
 * 关闭/重开或服务重启后会变化；只有 sessionFile 才能稳定定位完整 JSONL 账本。
 * 运行：node projects/codex-usage-plugin/tests/session-file-identity.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costCacheKey, fullSessionCostBreakdown, sessionLedgerFile } from "../index.mjs";

const CFG = { defaultBillingMode: "metered", billingOverrides: "{}" };
const dir = mkdtempSync(join(tmpdir(), "codex-usage-session-file-"));
const fileA = join(dir, "2026-01-01T00-00-00-000Z_persistent-a.jsonl");
const fileB = join(dir, "2026-01-01T00-00-01-000Z_persistent-b.jsonl");

function ledger(cost) {
	return `${JSON.stringify({ type: "session", id: "s" })}\n${JSON.stringify({ type: "model_change", id: "m", provider: "deepseek", modelId: "deepseek-flash" })}\n${JSON.stringify({ type: "message", id: "a", parentId: "m", message: { role: "assistant", usage: { cost: { total: cost } } } })}\n`;
}

try {
	writeFileSync(fileA, ledger(1.25), "utf8");
	writeFileSync(fileB, ledger(9.5), "utf8");

	// c1 是易变的内存 id；完整账本必须读 sessionFile，不能按 c1 猜文件名或退化为上下文。
	const reopened = { conversationId: "c1", sessionFile: fileA };
	assert.equal(sessionLedgerFile(reopened), fileA);
	const book = fullSessionCostBreakdown(reopened, CFG);
	assert.equal(book?.costSource, "session-ledger");
	assert.equal(book?.usd, 1.25);

	// 两个页面都可能得到 c1；缓存键必须按持久会话文件区分，否则会串成本。
	const otherReopened = { conversationId: "c1", sessionFile: fileB };
	assert.notEqual(costCacheKey(reopened), costCacheKey(otherReopened));
	assert.equal(costCacheKey(reopened), fileA);

	// 旧宿主只给 c1 时不得把它误认为会话文件 id，留给上下文回退而非读错账本。
	assert.equal(sessionLedgerFile({ conversationId: "c1" }), null);
	console.log("✓ 会话文件身份回归测试全部通过");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
