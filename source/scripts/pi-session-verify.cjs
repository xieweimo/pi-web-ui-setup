#!/usr/bin/env node
// Structural validator for pi session JSONL files:
//  * every line parses as JSON
//  * ids are unique
//  * every parentId resolves to an existing id (or null/absent at the root)
//  * the parent chain from the newest entry back to the root is acyclic
//  * no toolResult on the active chain lacks a matching toolCall in its nearest
//    ancestor assistant message (the DeepSeek/OpenAI "orphan tool" 400)
// Usage: node pi-session-verify.cjs <session.jsonl> [...more] | (no args = all under ~/.pi)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const targets = process.argv.slice(2);
const root = path.join(os.homedir(), ".pi", "agent", "sessions");
function collect(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collect(full, out);
		else if (entry.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}
const files = targets.length > 0 ? targets : fs.existsSync(root) ? collect(root) : [];

let failures = 0;
for (const file of files) {
	const problems = [];
	const values = [];
	const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
	lines.forEach((line, index) => {
		if (!line.trim()) return;
		try {
			values.push(JSON.parse(line));
		} catch (error) {
			problems.push(`L${index + 1} 不是合法 JSON: ${error.message}`);
		}
	});
	const byId = new Map();
	for (const value of values) {
		if (!value?.id) continue;
		if (byId.has(value.id)) problems.push(`重复 id: ${value.id}`);
		byId.set(value.id, value);
	}
	for (const value of values) {
		if (value?.parentId && !byId.has(value.parentId)) problems.push(`id=${value.id} 的 parentId=${value.parentId} 不存在`);
	}

	const last = values.filter((value) => value?.id).at(-1);
	const seen = new Set();
	let cursor = last;
	let steps = 0;
	while (cursor?.id && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		cursor = byId.get(cursor.parentId);
		steps++;
	}
	if (cursor?.id) problems.push(`活动链存在环，停在 id=${cursor.id}`);
	if (steps !== seen.size) problems.push("活动链长度与访问集合不一致");

	for (const value of values) {
		if (value?.type !== "message" || value.message?.role !== "toolResult" || !seen.has(value.id)) continue;
		const callId = value.message.toolCallId;
		let parentId = value.parentId;
		let matched = false;
		const guard = new Set();
		while (parentId && !guard.has(parentId)) {
			guard.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) break;
			if (parent.message?.role === "assistant") {
				matched = (parent.message.content ?? []).some((block) => block?.type === "toolCall" && block.id === callId);
				break;
			}
			parentId = parent.parentId;
		}
		if (!matched) problems.push(`L? id=${value.id} toolResult 无配对 toolCall (callId=${callId})`);
	}

	const label = path.relative(root, file);
	if (problems.length === 0) console.log(`ok       ${label}  (entries=${values.length}, chain=${seen.size})`);
	else {
		failures++;
		console.log(`FAIL     ${label}`);
		for (const problem of problems.slice(0, 10)) console.log(`         ${problem}`);
		if (problems.length > 10) console.log(`         ...还有 ${problems.length - 10} 条`);
	}
}
console.log(`\n${files.length} 个会话，${failures} 个有问题`);
process.exitCode = failures === 0 ? 0 : 1;
