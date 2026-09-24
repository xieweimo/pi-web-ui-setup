#!/usr/bin/env node
/**
 * 修复 pi 会话 JSONL 中「toolResult 找不到配对的 assistant toolCall」的断链。
 *
 * 为什么会出现：pi 的 openai-completions 适配层（pi-ai ~0.87）在
 * `transformMessages()` 里把 stopReason 为 error/aborted 的 assistant 消息整条丢弃，
 * 却没有连带丢弃它对应的 toolResult。于是发往 OpenAI / DeepSeek 的请求里出现
 * 孤立的 `{role:"tool"}`，两家都会拒：
 *   OpenAI  : No tool call found for function call output with call_id ...
 *   DeepSeek: Messages with role 'tool' must be a response to a preceding
 *             message with 'tool_calls' (request_id: ...)
 * 触发场景：工具调用跑到一半被强制中断（超时/停止/模型流卡死），随后用户点「重试」
 * 或切换模型继续同一会话。
 *
 * 判定规则（v2，与 pi 的实际转换语义一致）：
 *   toolResult 合法 ⟺ 沿 parentId 向上找到的**最近一条 assistant 消息**的 content
 *   里包含 id 等于该 toolResult.toolCallId 的 toolCall。
 *   注意不能只看「文件里某处存在同 id 的 toolCall」——被丢弃的 aborted assistant
 *   仍然留在 JSONL 里，但不在发往 API 的历史中。
 *   （v1 只查 id 以 synthetic-tool-result- 开头的条目，会漏掉真名的那条。
 *     需要旧行为时加 --synthetic-only。）
 *
 * 修复方式：删除孤儿 toolResult，并把指向它的子节点重接到它最近的保留祖先，
 * 保持后续分支可达。默认 dry-run，只有加 --apply 才写入；写前在同目录做
 * .bak-<时间戳> 备份，再用临时文件 + rename 原子替换（避免运行时读到半写文件）。
 * 只输出行号与 toolName，不输出会话正文。
 *
 * 用法：
 *   node repair-pi-orphan-tool-results-v2.js                      # 扫描 ~/.pi 全部会话（dry-run）
 *   node repair-pi-orphan-tool-results-v2.js <session.jsonl>      # 扫单个会话（dry-run）
 *   node repair-pi-orphan-tool-results-v2.js <session.jsonl> --apply
 *   ... --synthetic-only   只处理 id 以 synthetic-tool-result- 开头的条目（v1 行为）
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const syntheticOnly = args.includes("--synthetic-only");
const targets = args.filter((arg) => !arg.startsWith("--"));

const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");

function collectSessions(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectSessions(full, out);
		else if (entry.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

/**
 * pi 的适配层在 transformMessages() 里对 stopReason 为 error/aborted 的 assistant
 * 直接 `continue`（整条不发给 API）。因此判断配对时必须把这些「不会上线」的
 * assistant 当作不存在，只用真正会上线的 assistant 来配对。
 */
function isEmittingAssistant(message) {
	if (message?.role !== "assistant") return false;
	return message.stopReason !== "error" && message.stopReason !== "aborted";
}

function isOrphan(entry, byId, syntheticOnly) {
	const message = entry.value?.message;
	if (entry.value?.type !== "message" || message?.role !== "toolResult") return false;
	if (syntheticOnly && !String(entry.value?.id ?? "").startsWith("synthetic-tool-result-")) return false;
	const callId = message.toolCallId;
	if (!callId) return true;
	const seen = new Set();
	let parentId = entry.value.parentId;
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) return true;
		const parentMessage = parent.value?.message;
		if (parentMessage?.role === "assistant") {
			if (!isEmittingAssistant(parentMessage)) {
				// 这条 assistant 不会出现在请求里：继续往上找真正会上线的祖先。
				parentId = parent.value.parentId;
				continue;
			}
			const content = parentMessage.content;
			return !(Array.isArray(content) && content.some((block) => block?.type === "toolCall" && block.id === callId));
		}
		parentId = parent.value.parentId;
	}
	return true; // 走到根都没有会上线的 assistant
}

/**
 * 反向缺陷（阶段 2）：不会上线的 assistant（stopReason error/aborted）在分支链上
 * 留下了 toolCall，于是
 *   (a) DeepSeek 报「An assistant message with 'tool_calls' must be followed by tool
 *       messages responding to each 'tool_call_id'」——只要它的结果也是孤儿（阶段 1 已删），
 *       这个调用就没人应答；
 *   (b) pi-web-ui 0.95 的悬空调用自动修复（dangling-tools）会照着它补一条合成结果，
 *       把阶段 1 刚删掉的孤儿 tool 消息又写回来，错误反复出现。
 * 判定：assistant 不会上线，且它声明的 toolCallId 在同一分支下没有任何 toolResult。
 */
function orphanDeclarationsOf(entries) {
	const children = new Map();
	for (const item of entries) {
		if (!item.value?.parentId) continue;
		const list = children.get(item.value.parentId) ?? [];
		list.push(item);
		children.set(item.value.parentId, list);
	}
	const hasResultBelow = (startId, callId) => {
		const seen = new Set();
		const stack = [startId];
		while (stack.length > 0) {
			const current = stack.pop();
			if (seen.has(current)) continue;
			seen.add(current);
			for (const child of children.get(current) ?? []) {
				const childMessage = child.value?.message;
				if (childMessage?.role === "toolResult" && childMessage.toolCallId === callId) return true;
				stack.push(child.value.id);
			}
		}
		return false;
	};

	const out = [];
	for (const entry of entries) {
		const message = entry.value?.message;
		if (entry.value?.type !== "message" || message?.role !== "assistant") continue;
		if (isEmittingAssistant(message)) continue;
		const blocks = (message.content ?? []).filter((block) => block?.type === "toolCall" && block.id);
		if (blocks.length === 0) continue;
		const unanswered = blocks.filter((block) => !hasResultBelow(entry.value.id, block.id)).map((block) => block.id);
		if (unanswered.length > 0) out.push({ id: entry.value.id, line: entry.index + 1, unanswered });
	}
	return out;
}

function repairFile(file) {
	const raw = fs.readFileSync(file, "utf8");
	const hasFinalNewline = /\r?\n$/.test(raw);
	const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
	const entries = [];
	for (let index = 0; index < lines.length; index++) {
		let value;
		try {
			value = JSON.parse(lines[index]);
		} catch (error) {
			throw new Error(`${file}: 第 ${index + 1} 行不是合法 JSON：${error.message}`);
		}
		entries.push({ index, value });
	}
	const byId = new Map(entries.filter((entry) => entry.value?.id).map((entry) => [entry.value.id, entry]));

	// 阶段 1：删掉「上了线却找不到调用」的孤儿 toolResult。
	const orphanIds = new Set();
	for (const entry of entries) if (isOrphan(entry, byId, syntheticOnly)) orphanIds.add(entry.value.id);

	// 阶段 2：剥掉不会上线的 assistant 留下的幽灵 toolCall——否则 (a) DeepSeek 报
	// 「有 tool_calls 却没人应答」，(b) pi-web-ui 0.95 的悬空调用修复会照着它补结果，
	// 把阶段 1 刚删掉的孤儿又写回来。必须按「阶段 1 之后」的状态判定。
	const survivors = entries.filter((entry) => !orphanIds.has(entry.value?.id));
	const phantomByAssistant = new Map(orphanDeclarationsOf(survivors).map((item) => [item.id, item]));

	const relative = path.relative(sessionsRoot, file);
	if (orphanIds.size === 0 && phantomByAssistant.size === 0) {
		console.log(`ok        ${relative}`);
		return 0;
	}

	// 被删节点重定向到最近的保留祖先，保证后续分支仍可达。
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

	if (orphanIds.size > 0) {
		console.log(`ORPHANS   ${relative}  (待删 ${orphanIds.size} 条)`);
		for (const id of orphanIds) {
			const entry = byId.get(id);
			console.log(`          L${entry.index + 1} id=${id} tool=${entry.value.message.toolName ?? "?"} callId=${entry.value.message.toolCallId ?? "(无)"}`);
		}
	}
	for (const phantom of phantomByAssistant.values()) {
		console.log(`PHANTOM   ${relative} L${phantom.line} id=${phantom.id} assistant.stopReason=error/aborted，无人应答的 toolCall：${phantom.unanswered.join(", ")}`);
	}
	if (!apply) return orphanIds.size + phantomByAssistant.size;

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
		const phantom = phantomByAssistant.get(value.id);
		if (phantom && Array.isArray(value.message?.content)) {
			value.message.content = value.message.content.filter((block) => !(block?.type === "toolCall" && phantom.unanswered.includes(block.id)));
		}
		repaired.push(JSON.stringify(value));
	}

	const backup = `${file}.bak-${Date.now()}`;
	fs.copyFileSync(file, backup);
	const temp = `${file}.repair-${process.pid}.tmp`;
	fs.writeFileSync(temp, repaired.join("\n") + (hasFinalNewline ? "\n" : ""), "utf8");
	fs.renameSync(temp, file);
	console.log(`          ✓ 已删除 ${orphanIds.size} 条孤儿结果、剥掉 ${phantomByAssistant.size} 处幽灵 toolCall，备份：${path.basename(backup)}`);
	return orphanIds.size + phantomByAssistant.size;
}

const files = targets.length > 0 ? targets.map((target) => path.resolve(target)) : fs.existsSync(sessionsRoot) ? collectSessions(sessionsRoot) : [];
if (files.length === 0) {
	console.error("没有找到会话文件。用法：node repair-pi-orphan-tool-results-v2.js [session.jsonl] [--apply] [--synthetic-only]");
	process.exit(2);
}

let total = 0;
for (const file of files) {
	if (!fs.existsSync(file)) {
		console.log(`ERROR     ${file}: 文件不存在`);
		continue;
	}
	try {
		total += repairFile(file);
	} catch (error) {
		console.log(`ERROR     ${file}: ${error.message}`);
		process.exitCode = 1;
	}
}
console.log(`\n共 ${total} 条孤儿 toolResult${apply ? "（已修复）" : "（dry-run，未写入）"}`);
