#!/usr/bin/env node
/**
 * 修复 pi 会话 JSONL 中「toolResult 找不到对应祖先 toolCall」的断链。
 *
 * 触发场景：工具执行超时、模型流卡死或切换模型时，恢复流程会补一条
 * synthetic-tool-result-*，但它的 parent 链已跨过 assistant 回合，
 * OpenAI Responses 随后会拒绝整个历史：
 *   No tool call found for function call output with call_id ...
 * 表现就是「模型断了以后换模型也一直卡住用不了」。
 *
 * 用法：
 *   node scripts/repair-pi-orphan-tool-results.js --scan              # 巡检全部会话，只报告
 *   node scripts/repair-pi-orphan-tool-results.js <session.jsonl>     # 单文件 dry-run
 *   node scripts/repair-pi-orphan-tool-results.js <session.jsonl> --apply
 *
 * 安全约定：只在 --apply 时写入；写前在同目录留下 .bak-<时间戳> 备份；
 * 同目录原子替换（先写 .tmp 再 rename），避免运行中的服务读到半写入的 JSONL；
 * 从不输出会话正文与工具结果内容。
 */
const fs = require("node:fs");
const path = require("node:path");

const SESSIONS_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "sessions");

function collectSessions(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectSessions(full, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

/** 解析会话并找出「直接父 assistant 里没有对应 toolCall」的 synthetic 结果。 */
function detect(file) {
	const raw = fs.readFileSync(file, "utf8");
	const hasFinalNewline = /\r?\n$/.test(raw);
	const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
	const entries = lines.map((line, index) => {
		try {
			return { line, index, value: JSON.parse(line) };
		} catch (error) {
			throw new Error(`${file} 第 ${index + 1} 行不是合法 JSON：${error.message}`);
		}
	});
	const byId = new Map(entries.filter((entry) => entry.value?.id).map((entry) => [entry.value.id, entry]));

	/** 多个并行 toolResult 可以互为父子，因此跳过它们，只看最近一条 assistant。 */
	function belongsToNearestToolUse(entry, toolCallId) {
		const seen = new Set();
		let parentId = entry.value?.parentId;
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) return false;
			const message = parent.value?.message;
			if (message?.role === "assistant") {
				const content = message.content;
				return Array.isArray(content) && content.some((block) => block?.type === "toolCall" && block.id === toolCallId);
			}
			parentId = parent.value?.parentId;
		}
		return false;
	}

	const orphanIds = new Set();
	for (const entry of entries) {
		const message = entry.value?.message;
		if (entry.value?.type !== "message" || message?.role !== "toolResult") continue;
		const callId = String(message.toolCallId ?? "");
		const synthetic = String(entry.value?.id ?? "").startsWith("synthetic-tool-result-");
		if (synthetic && callId && !belongsToNearestToolUse(entry, callId)) orphanIds.add(entry.value.id);
	}

	// 被删节点的子节点重接到最近的保留祖先，保证后续分支仍可达。
	const redirect = new Map();
	for (const id of orphanIds) {
		let parentId = byId.get(id)?.value?.parentId;
		const seen = new Set([id]);
		while (parentId && orphanIds.has(parentId) && !seen.has(parentId)) {
			seen.add(parentId);
			parentId = byId.get(parentId)?.value?.parentId;
		}
		redirect.set(id, parentId ?? null);
	}
	const report = [...orphanIds].map((id) => {
		const entry = byId.get(id);
		return { line: entry.index + 1, id, toolCallId: entry.value.message.toolCallId, toolName: entry.value.message.toolName };
	});
	return { entries, orphanIds, redirect, report, hasFinalNewline };
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const scan = args.includes("--scan");
const target = args.find((arg) => !arg.startsWith("--"));

if (scan) {
	let damaged = 0;
	let total = 0;
	for (const session of collectSessions(SESSIONS_ROOT)) {
		total += 1;
		let found;
		try {
			found = detect(session);
		} catch (error) {
			console.log(`  ⚠ 跳过（解析失败）：${session}`);
			continue;
		}
		if (!found.orphanIds.size) continue;
		damaged += 1;
		console.log(`  ${found.orphanIds.size} 条断链 · ${session}`);
	}
	console.log(damaged ? `发现 ${damaged}/${total} 个会话存在断链，确认空闲后逐个 --apply 修复` : `✓ 巡检 ${total} 个会话，未发现断链`);
	process.exit(0);
}

if (!target) {
	console.error("用法：node scripts/repair-pi-orphan-tool-results.js --scan");
	console.error("      node scripts/repair-pi-orphan-tool-results.js <session.jsonl> [--apply]");
	process.exit(2);
}
const file = path.resolve(target);
if (!fs.existsSync(file) || !file.endsWith(".jsonl")) {
	console.error("✗ session JSONL 不存在：" + file);
	process.exit(2);
}

const { entries, orphanIds, redirect, report, hasFinalNewline } = detect(file);
if (!orphanIds.size) {
	console.log("✓ 未发现断链 toolResult；无需修复");
	process.exit(0);
}
console.log(`发现 ${report.length} 条断链 synthetic toolResult：`);
for (const item of report) console.log(`  行 ${item.line} · ${item.toolName} · ${item.toolCallId}`);
if (!apply) {
	console.log("未写入（dry-run）。确认会话空闲后追加 --apply 执行修复。");
	process.exit(0);
}

const repaired = [];
for (const entry of entries) {
	if (orphanIds.has(entry.value?.id)) continue;
	const value = structuredClone(entry.value);
	let parentId = value.parentId;
	const seen = new Set();
	while (parentId && redirect.has(parentId) && !seen.has(parentId)) {
		seen.add(parentId);
		parentId = redirect.get(parentId);
	}
	if (value.parentId !== parentId) value.parentId = parentId;
	repaired.push(JSON.stringify(value));
}
const backup = `${file}.bak-${Date.now()}`;
fs.copyFileSync(file, backup);
const temp = `${file}.repair-${process.pid}.tmp`;
fs.writeFileSync(temp, repaired.join("\n") + (hasFinalNewline ? "\n" : ""), "utf8");
fs.renameSync(temp, file); // 同目录原子替换，避免运行时读到半写入 JSONL。
console.log(`✓ 已移除 ${orphanIds.size} 条断链结果并重接后续父链`);
console.log("  原文件备份：" + backup);
