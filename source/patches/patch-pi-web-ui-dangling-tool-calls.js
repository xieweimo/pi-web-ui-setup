#!/usr/bin/env node
/**
 * 修正 pi-web-ui 0.95.0 自带「悬空 toolCall 自动修复」（issue #280）的两处错位。
 *
 * 背景：dangling-tools.healDanglingToolCallFile 是 append-only——把合成 toolResult
 * 追加到**文件尾**，parentId 接在最后一条 entry 之后。
 *
 * v1（dangling-active-chain-filter-v1）修掉的是「老分支残留」：
 * 只补「当前分支（从最后一条 entry 沿 parentId 回溯）上最后一条 assistant」名下的
 * 悬空调用。但它仍有一个致命盲点——**被系统中断的 assistant**：
 *
 *   stopReason 为 error / aborted 的 assistant 在 pi 的 openai-completions 适配层里
 *   根本不会上线（transformMessages 里 `if(stopReason==="error"||"aborted") continue`），
 *   可它声明的 toolCall 依旧留在 JSONL 分支链上，于是被当成「悬空调用」补上合成结果。
 *   补出来的 toolResult 在请求里就是孤立的 function_call_output / role:"tool"，
 *   两家 provider 都直接拒：
 *     OpenAI  : No tool call found for function call output with call_id ...
 *     DeepSeek: Messages with role 'tool' must be a response to a preceding message
 *               with 'tool_calls' (request_id: ...)
 *   用户表现：模型中断后点「重试」，服务自己把错误的历史又补一笔，400 越修越多。
 *
 * v2 修正：tailAssistantToolCallIds 回溯时**跳过 error/aborted 的 assistant**，
 * 只认真正会上线的链尾 assistant。这样中断留下的幽灵调用不会被补结果。
 *
 * 幂等（v1 → v2 自动升级）；精确匹配 0.95.0 产物；锚点变化时退出码 2，不做模糊替换。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "dangling-active-chain-filter-v2";
const v1Marker = "dangling-active-chain-filter-v1";
const server = locateWebUiFile("dist", "server");
const target = server ? path.join(server, "dangling-tools.js") : null;
if (!target || !fs.existsSync(target)) {
	console.error("✗ 找不到 pi-web-ui 的 dist/server/dangling-tools.js");
	process.exit(1);
}
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
	console.log("✓ 悬空 toolCall 分支过滤补丁 v2 已存在");
	process.exit(0);
}

const v1Function = `function tailAssistantToolCallIds(entries, lastId) {
    const byId = new Map();
    for (const entry of entries) {
        if (entry && typeof entry === "object" && typeof entry.id === "string")
            byId.set(entry.id, entry);
    }
    const seen = new Set();
    let cursor = lastId;
    while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const entry = byId.get(cursor);
        if (!entry)
            break;
        const msg = entry.message;
        if (msg && typeof msg === "object" && msg.role === "assistant") {
            return new Set(toolCallsOfMessage(msg).map((c) => c.toolCallId));
        }
        cursor = entry.parentId;
    }
    return new Set();
}`;

const v2Function = `/**
 * ${marker} — 当前分支尾部的 assistant 名下的 toolCall id 集合。
 * 从最后一条 entry 沿 parentId 回溯；**跳过 stopReason 为 error/aborted 的
 * assistant**——它们在适配层里不会上线，其 toolCall 属于幽灵调用，补结果只会
 * 造出孤立的 function_call_output。遇到第一条真正会上线的 assistant 即返回。
 */
function tailAssistantToolCallIds(entries, lastId) {
    const byId = new Map();
    for (const entry of entries) {
        if (entry && typeof entry === "object" && typeof entry.id === "string")
            byId.set(entry.id, entry);
    }
    const seen = new Set();
    let cursor = lastId;
    while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const entry = byId.get(cursor);
        if (!entry)
            break;
        const msg = entry.message;
        if (msg && typeof msg === "object" && msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
            return new Set(toolCallsOfMessage(msg).map((c) => c.toolCallId));
        }
        cursor = entry.parentId;
    }
    return new Set();
}`;

const anchor = "export function healDanglingToolCallFile(filePath) {";
const helper = `/**
 * ${v1Marker} — 当前分支尾部的 assistant 名下的 toolCall id 集合。
 * 从最后一条 entry 沿 parentId 回溯，遇到的第一条 assistant 即链尾 assistant；
 * 只有它的 toolCall 才能被安全地补上合成结果（紧邻、不跨回合）。
 */
${v1Function}
${anchor}`;
const v1Filter = `    // dangling-active-chain-filter-v1：跳过不在当前分支尾部 assistant 名下的悬空调用，
    // 否则合成结果会落到当前分支尾部并跨过 assistant 回合，变成孤立的 function_call_output。
    const tailCalls = tailAssistantToolCallIds(entries, lastId);`;
const v2Filter = `    // ${marker}：跳过不在当前分支尾部 assistant 名下的悬空调用，
    // 否则合成结果会落到当前分支尾部并跨过 assistant 回合，变成孤立的 function_call_output。
    const tailCalls = tailAssistantToolCallIds(entries, lastId);`;

const counts = {
	v1Function: source.split(v1Function).length - 1,
	v2Function: source.split(v2Function).length - 1,
	anchor: source.split(anchor).length - 1,
	v1Filter: source.split(v1Filter).length - 1,
};

if (counts.v2Function === 1 && counts.v1Filter === 1) {
	// 半升级状态：只换标记与说明
	source = source.replace(v2Function, v2Function.replace(v1Marker, marker)).replace(v1Filter, v2Filter);
	fs.writeFileSync(target, source, "utf8");
	console.log("✓ 悬空 toolCall 过滤补丁已升到 v2（补齐标记）");
	process.exit(0);
}
if (counts.v1Function === 1 && counts.v1Filter === 1) {
	source = source.replace(v1Function, v2Function).replace(v1Filter, v2Filter);
	fs.writeFileSync(target, source, "utf8");
	console.log("✓ 悬空 toolCall 过滤补丁已从 v1 升级到 v2（跳过 error/aborted assistant）");
	process.exit(0);
}
if (counts.anchor === 1 && counts.v1Function === 0) {
	source = source.replace(anchor, helper).replace(
		"    const dangling = findDanglingToolCalls(entries);\n    if (dangling.length === 0)\n        return 0;",
		`${v2Filter}\n    const dangling = findDanglingToolCalls(entries).filter((d) => tailCalls.has(d.toolCallId));\n    if (dangling.length === 0)\n        return 0;`,
	);
	// 未打 v1 时 helper 里带的是 v1 文案，直接换成 v2 函数体
	source = source.replace(v1Function, v2Function);
	fs.writeFileSync(target, source, "utf8");
	console.log("✓ 悬空 toolCall 过滤补丁已应用（v2，直接注入）");
	process.exit(0);
}

console.error(`✗ 锚点命中异常（v1Function=${counts.v1Function} anchor=${counts.anchor} v1Filter=${counts.v1Filter}），拒绝模糊替换`);
process.exit(2);
