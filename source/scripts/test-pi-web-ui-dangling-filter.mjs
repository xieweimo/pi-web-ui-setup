#!/usr/bin/env node
/**
 * 验证「悬空 toolCall 分支过滤」补丁：只补当前分支尾部 assistant 名下的悬空调用，
 * 老分支残留必须跳过（否则合成结果会跨 assistant 回合，导致 provider 报
 * "No tool call found for function call output"）。
 *
 * 运行：node scripts/test-pi-web-ui-dangling-filter.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDanglingToolCalls } from "file:///C:/Users/X/AppData/Roaming/npm/node_modules/pi-web-ui/dist/server/dangling-tools.js";

const { healDanglingToolCallFile } = await import(
	"file:///C:/Users/X/AppData/Roaming/npm/node_modules/pi-web-ui/dist/server/dangling-tools.js"
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dangling-test-"));
let seq = 0;
const write = (entries) => {
	seq += 1;
	const file = path.join(dir, `case-${seq}.jsonl`);
	fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return file;
};
const read = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const assistant = (id, parentId, content) => ({
	type: "message",
	id,
	parentId,
	message: { role: "assistant", content, stopReason: "toolUse" },
});
const user = (id, parentId) => ({
	type: "message",
	id,
	parentId,
	message: { role: "user", content: [{ type: "text", text: "hi" }] },
});
const call = (id, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });

// 场景 A：链尾 assistant 的 toolCall 悬空 → 必须补一条，且 parentId 指向该 assistant。
const fileA = write([user("root", null), assistant("a1", "root", [call("call-A")])]);
assert.equal(healDanglingToolCallFile(fileA), 1, "链尾悬空调用应被补上");
const rowsA = read(fileA);
const appendedA = rowsA[rowsA.length - 1];
assert.equal(appendedA.message.role, "toolResult");
assert.equal(appendedA.message.toolCallId, "call-A");
assert.equal(appendedA.parentId, "a1", "合成结果必须紧接发出调用的 assistant");

// 场景 B：悬空调用属于被分叉掉的老分支 → 必须跳过，不得往当前分支尾部追加孤儿。
const fileB = write([
	user("root", null),
	assistant("a1", "root", [call("call-B")]),
	user("b1", "root"),
	assistant("a2", "b1", [{ type: "text", text: "另起一轮" }]),
]);
assert.equal(healDanglingToolCallFile(fileB), 0, "老分支残留不得被拖进当前分支");
assert.equal(read(fileB).length, 4, "跳过时不应写入任何内容");

// 场景 C：链尾 assistant 的调用已有配对结果 → 健康，不追加。
const fileC = write([
	user("root", null),
	assistant("a1", "root", [call("call-C")]),
	{ type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "call-C", toolName: "bash", content: [{ type: "text", text: "ok" }] } },
]);
assert.equal(healDanglingToolCallFile(fileC), 0, "健康会话不应被改动");
assert.equal(read(fileC).length, 3);

// 场景 D：老分支与链尾同时悬空 → 只补链尾那一条。
const fileD = write([
	user("root", null),
	assistant("old", "root", [call("call-old")]),
	user("b1", "root"),
	assistant("a2", "b1", [call("call-tail")]),
]);
assert.equal(healDanglingToolCallFile(fileD), 1, "只应补链尾一条");
const rowsD = read(fileD);
assert.equal(rowsD[rowsD.length - 1].message.toolCallId, "call-tail");
assert.equal(rowsD[rowsD.length - 1].parentId, "a2");
assert.equal(rowsD.filter((row) => row.message?.toolCallId === "call-old").length, 0, "老分支调用不得被补");

// 场景 E：修复后文件必须是合法配对链（最近 assistant 含该 callId），即不再产生孤儿。
const tailAssistant = rowsD[rowsD.length - 2];
assert.equal(tailAssistant.message.role, "assistant");
assert.ok(tailAssistant.message.content.some((block) => block.type === "toolCall" && block.id === "call-tail"));

// 顺带确认上游纯函数仍能看到老分支悬空调用（跳过是 heal 的策略，不是检测失效）。
assert.ok(findDanglingToolCalls(read(fileB)).some((item) => item.toolCallId === "call-B"));

fs.rmSync(dir, { recursive: true, force: true });
console.log("✓ 悬空 toolCall 分支过滤：链尾补、老分支跳过、混合只补链尾、健康不动");
