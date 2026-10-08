#!/usr/bin/env node
/**
 * pi 内核补丁：根治 `Invalid 'input[N].name'`（被污染的 toolCall.name）。
 *
 * 现象：会话切到 openai-codex（Responses API）后固定 400——
 *   Invalid 'input[97].name': string does not match pattern.
 *   Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
 * 而且「重试」永远失败：脏数据已经写进会话账本，每次请求都会带上去。
 *
 * 根因（由 work/backups 里的原始账本取证）：OpenAI 兼容 provider（实测
 * provider=deepseek / model=deepseek-flash / api=openai-completions）返回的
 * `tool_calls[].function.name` 会被正文污染，实测三种形态：
 *   1) name = 整段正文（如 "plan:new:1=…]]\n\n**截图回答**…"）
 *   2) name = "plan 标记 + <｜DSML｜tool_calls> <｜DSML｜invoke name=" 泄漏文本
 *   3) name = "..." 之类的残片
 * pi-ai 的 openai-completions 适配层直接 `block.name = toolCall.function.name`
 * 不做校验，pi-agent-core 也照单写进账本并生成 `Tool … not found` 的结果。
 * 于是脏 name 永久留在历史里，谁再读这段历史（OpenAI 系）谁就 400。
 *
 * 修法（双保险，都只做「归一化」，不丢历史结构）：
 *   A. 源头：pi-agent-core/dist/agent-loop.js —— assistant 消息一落地就先净化
 *      content 里的 toolCall.name，脏名字改成占位工具名 invalid_tool_call
 *      （合法字符、且不匹配任何真实工具 → pi 走既有 not found 分支，模型自己重试），
 *      并把原始脏名截断后打到 stderr 便于定位。**账本从此不再落脏 name。**
 *   B. 出口：pi-ai/dist/api/openai-responses-shared.js —— convertResponsesMessages
 *      构造 function_call 时就地归一化 name，兜住「别的机器/历史遗留」的脏账本。
 *      function_call 与 function_call_output 的 call_id 都来自同一 toolCall.id，
 *      只换 name 不换 id，所以配对关系不变，不会产生孤立 output 的新 400。
 *
 * 幂等：以 marker 判定，重复执行无副作用；锚点不唯一/找不到时退出码 2（不做模糊替换）。
 * 回滚：--remove 按 marker 反向还原（先备份，见下）。
 * 备份：改前把原文件复制到 work/backups/pi-core/<文件名>.<时间戳>.bak。
 *
 * 用法：
 *   node patches/patch-pi-invalid-toolcall-names.js            # 应用（幂等）
 *   node patches/patch-pi-invalid-toolcall-names.js --quiet
 *   node patches/patch-pi-invalid-toolcall-names.js --remove   # 回滚
 *
 * 退出码：0 = 已应用；2 = 锚点失效 / 找不到目标。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { piCodingAgentRoots, resolvePiDep } = require("../scripts/pi-core-locate.js");

const MARKER = "pi-invalid-toolcall-name-v1";
const PLACEHOLDER = "invalid_tool_call";
const QUIET = process.argv.includes("--quiet");
const REMOVE = process.argv.includes("--remove");
const ROOT = path.resolve(__dirname, "..");
// 备份目录：默认落仓库 work/backups/pi-core；测试可用 PI_PATCH_BACKUP_DIR 指向临时目录，
// 避免测试在真实备份目录里产生/清理备份（万一此时恰好有一次真实重打，会被误删）。
const BACKUP_DIR = process.env.PI_PATCH_BACKUP_DIR
	? path.resolve(process.env.PI_PATCH_BACKUP_DIR)
	: path.join(ROOT, "work", "backups", "pi-core");

const log = (msg) => {
	if (!QUIET) console.log(msg);
};

// ---------------------------------------------------------------------------
// 目标定位（与 scripts/pi-core-locate.js 共用，避免补丁/校验脚本各写一套）
// ---------------------------------------------------------------------------
// piCodingAgentRoots()：所有 pi-coding-agent 安装根（pi-web-ui 内嵌 / 全局 npm / 源码项目 / 便携安装）
// resolvePiDep()：从某个根向上解析 @earendil-works/<pkg>

// ---------------------------------------------------------------------------
// 注入片段
// ---------------------------------------------------------------------------

const SOURCE_ANCHOR = "const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);";

const SOURCE_CALL = `            /* ${MARKER} */ sanitizeInvalidToolCallNames(message);`;

const SOURCE_FN = `/* ${MARKER}:start */
/**
 * ${MARKER}（源头净化，见 patches/patch-pi-invalid-toolcall-names.js）
 * provider 返回的 function.name 可能被正文/DSML 文本污染，OpenAI Responses API
 * 要求 name 匹配 ^[a-zA-Z0-9_-]+$，脏名字一旦写进账本，切到 openai-codex 后
 * 每次请求都 400 且重试永远失败。这里在消息落地（写账本）前就归一化。
 */
function sanitizeInvalidToolCallNames(message) {
    if (!message || !Array.isArray(message.content))
        return;
    const legal = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const block of message.content) {
        if (!block || block.type !== "toolCall")
            continue;
        const raw = block.name;
        if (typeof raw === "string" && legal.test(raw))
            continue;
        try {
            process.stderr.write(\`[${MARKER}] 非法工具名已归一化为 ${PLACEHOLDER}（provider=\${message.provider ?? "?"} model=\${message.model ?? "?"}）：\${String(raw).slice(0, 200)}\\n\`);
        }
        catch {
            /* 日志失败不影响主流程 */
        }
        block.name = "${PLACEHOLDER}";
    }
}
/* ${MARKER}:end */`;

const OUT_ANCHOR_DEF = `                else if (block.type === "toolCall") {
                    const toolCall = block;`;

const OUT_ANCHOR_DEF_NEW = `                else if (block.type === "toolCall") {
                    const toolCall = block;
                    /* ${MARKER} */ const safeToolName = sanitizeResponsesFunctionName(toolCall.name);`;

const OUT_ANCHOR_GET = "const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);";
const OUT_ANCHOR_GET_NEW = "const customInputProperty = options?.grammarToolInputProperties?.get(safeToolName);";

const OUT_ANCHOR_NAME = "name: toolCall.name,";
const OUT_ANCHOR_NAME_NEW = "name: safeToolName,";

const OUT_FN = `/* ${MARKER}:start */
/**
 * ${MARKER}（出口保底，见 patches/patch-pi-invalid-toolcall-names.js）
 * 兜住历史账本里残留的脏 function.name：构造 Responses 请求时就地归一化，
 * 只换 name、不动 call_id，function_call 与 function_call_output 仍然配对。
 */
function sanitizeResponsesFunctionName(name) {
    return typeof name === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : "${PLACEHOLDER}";
}
/* ${MARKER}:end */`;

// ---------------------------------------------------------------------------
// 读写工具
// ---------------------------------------------------------------------------

/** 在 sourceMappingURL 注释之前插入代码。 */
function appendBeforeSourceMap(source, code, name) {
	const re = /\/\/# sourceMappingURL=.*(\r?\n)?$/;
	const m = re.exec(source);
	if (!m) {
		console.error(`✗ ${name}: 找不到 sourceMappingURL 尾部标记，拒绝盲插`);
		return null;
	}
	const nl = source.endsWith("\n") ? "" : "\n";
	return source.slice(0, m.index) + nl + code + "\n" + source.slice(m.index);
}

/** 删除 marker:start … marker:end 包裹的整块（含前后空行）。 */
function stripBlock(source, name) {
	const re = new RegExp(`(\\r?\\n)?/\\* ${MARKER}:start \\*/[\\s\\S]*?/\\* ${MARKER}:end \\*/\\r?\\n?`, "m");
	if (!re.test(source)) {
		console.error(`✗ ${name}: 找不到 ${MARKER} 代码块，无法回滚`);
		return null;
	}
	return source.replace(re, "\n");
}

function backup(file) {
	fs.mkdirSync(BACKUP_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = path.join(BACKUP_DIR, `${path.basename(file)}.${stamp}.bak`);
	fs.writeFileSync(dest, fs.readFileSync(file));
	return dest;
}

/** 原子写盘：先写临时文件再 rename，避免磁盘满/中断时把目标文件写半。
 *  写入与 rename 都在 try 内：任何一步失败都会清掉临时文件、目标文件保持原样。
 *  注意：这里不做 fsync，防的是「进程中断写半」，不防「掉电丢缓存」（见文档 §8）。 */
function atomicWrite(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, file);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
		throw err;
	}
}

/** 写盘 + `node --check` 语法验证；语法不过就回滚。 */
function writeChecked(file, text) {
	const original = fs.readFileSync(file, "utf8");
	const bak = backup(file);
	try {
		atomicWrite(file, text);
	} catch (err) {
		console.error(`✗ ${path.basename(file)}: 写盘失败（${err.code || err.message}），原文件未被改动`);
		return false;
	}
	const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 30000 });
	if (r.status !== 0) {
		try {
			atomicWrite(file, original);
		} catch {
			fs.writeFileSync(file, original);
		}
		console.error(`✗ ${path.basename(file)}: 语法校验失败，已回滚（备份 ${bak}）`);
		console.error((r.stderr || "").split("\n").slice(0, 3).join("\n"));
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// 两个补丁点
// ---------------------------------------------------------------------------

function patchAgentLoop(file) {
	const name = path.basename(file);
	let source = fs.readFileSync(file, "utf8");
	if (REMOVE) {
		if (!source.includes(MARKER)) {
			log(`✓ ${name}: 未打补丁，无需回滚`);
			return true;
		}
		let next = source.replace(`            /* ${MARKER} */ sanitizeInvalidToolCallNames(message);\n`, "");
		next = stripBlock(next, name);
		if (next === null) return false;
		if (next === source) {
			console.error(`✗ ${name}: 回滚锚点未命中`);
			return false;
		}
		// 残留断言：注入行没删干净时绝不能写盘 —— 否则函数定义已被 stripBlock 删掉、
		// 调用还在，运行时会 ReferenceError（node --check 查不出这类问题）。
		// 用宽松正则而不是 includes(原注入行)：后者依赖原文缩进，缩进一变就测不到、也拦不住。
		if (/(^|[^.\w])sanitizeInvalidToolCallNames\s*\(/m.test(next)) {
			console.error(`✗ ${name}: 回滚后仍有 sanitizeInvalidToolCallNames 调用残留（注入行未删除），拒绝写盘`);
			return false;
		}
		// 注意不要写成 `return writeChecked(...) && log(...)`：log() 无返回值，
		// 整个表达式会恒为 undefined → 成功也返回 falsy → main 判失败、退出码 2（回滚「看着失败」）。
		if (!writeChecked(file, next)) return false;
		log(`✓ ${name}: 已回滚（源头净化）`);
		return true;
	}
	if (source.includes(MARKER)) {
		log(`✓ ${name}: 源头净化补丁已存在`);
		return true;
	}
	const hits = source.split(SOURCE_ANCHOR).length - 1;
	if (hits !== 1) {
		console.error(`✗ ${name}: streamAssistantResponse 锚点命中 ${hits} 次（期望 1），pi 版本可能已变`);
		return false;
	}
	source = source.replace(SOURCE_ANCHOR, `${SOURCE_ANCHOR}\n${SOURCE_CALL}`);
	const next = appendBeforeSourceMap(source, SOURCE_FN, name);
	if (next === null) return false;
	if (!writeChecked(file, next)) return false;
	log(`✓ ${name}: 源头净化补丁已应用（写账本前归一化 toolCall.name）`);
	return true;
}

function patchResponsesShared(file) {
	const name = path.basename(file);
	const source = fs.readFileSync(file, "utf8");
	if (REMOVE) {
		if (!source.includes(MARKER)) {
			log(`✓ ${name}: 未打补丁，无需回滚`);
			return true;
		}
		let next = source
			.replace(`                    /* ${MARKER} */ const safeToolName = sanitizeResponsesFunctionName(toolCall.name);\n`, "")
			.replace(OUT_ANCHOR_GET_NEW, OUT_ANCHOR_GET)
			.split(OUT_ANCHOR_NAME_NEW)
			.join(OUT_ANCHOR_NAME);
		next = stripBlock(next, name);
		if (next === null) return false;
		// 同上：函数定义删了、调用行还在就拒绝写盘（防 ReferenceError），宽松正则不依赖缩进。
		if (/(^|[^.\w])sanitizeResponsesFunctionName\s*\(/m.test(next)) {
			console.error(`✗ ${name}: 回滚后仍有 sanitizeResponsesFunctionName 调用残留（safeToolName 声明未删除），拒绝写盘`);
			return false;
		}
		if (!writeChecked(file, next)) return false;
		log(`✓ ${name}: 已回滚（出口保底）`);
		return true;
	}
	if (source.includes(MARKER)) {
		log(`✓ ${name}: 出口保底补丁已存在`);
		return true;
	}
	const counts = {
		def: source.split(OUT_ANCHOR_DEF).length - 1,
		get: source.split(OUT_ANCHOR_GET).length - 1,
		names: source.split(OUT_ANCHOR_NAME).length - 1,
	};
	if (counts.def !== 1 || counts.get !== 1 || counts.names !== 2) {
		console.error(`✗ ${name}: 锚点命中异常 def=${counts.def} get=${counts.get} name=${counts.names}（期望 1/1/2），pi 版本可能已变`);
		return false;
	}
	let next = source
		.replace(OUT_ANCHOR_DEF, OUT_ANCHOR_DEF_NEW)
		.replace(OUT_ANCHOR_GET, OUT_ANCHOR_GET_NEW)
		.split(OUT_ANCHOR_NAME)
		.join(OUT_ANCHOR_NAME_NEW);
	next = appendBeforeSourceMap(next, OUT_FN, name);
	if (next === null) return false;
	if (!writeChecked(file, next)) return false;
	log(`✓ ${name}: 出口保底补丁已应用（构造 function_call 时归一化 name）`);
	return true;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
	const roots = piCodingAgentRoots();
	if (roots.length === 0) {
		console.error("✗ 找不到任何 pi-coding-agent 安装（pi-web-ui 内嵌 / 全局 npm / 源码项目）");
		process.exit(2);
	}
	let ok = true;
	let touched = 0;
	for (const root of roots) {
		const loop = resolvePiDep(root, "pi-agent-core");
		const ai = resolvePiDep(root, "pi-ai");
		const loopFile = loop ? path.join(loop, "dist", "agent-loop.js") : null;
		const sharedFile = ai ? path.join(ai, "dist", "api", "openai-responses-shared.js") : null;
		log(`→ ${root}`);
		if (loopFile && fs.existsSync(loopFile)) {
			if (!patchAgentLoop(loopFile)) ok = false;
			else touched++;
		} else {
			console.error(`✗ 找不到 pi-agent-core/dist/agent-loop.js（${root}）`);
			ok = false;
		}
		if (sharedFile && fs.existsSync(sharedFile)) {
			if (!patchResponsesShared(sharedFile)) ok = false;
			else touched++;
		} else {
			console.error(`✗ 找不到 pi-ai/dist/api/openai-responses-shared.js（${root}）`);
			ok = false;
		}
	}
	if (!ok) process.exit(2);
	log(`✓ ${MARKER} 完成：${roots.length} 个 pi 安装 / ${touched} 个目标文件`);
}

// 直接运行时才执行补丁；被 require（测试）时只导出常量，避免误触发 apply。
module.exports = {
	MARKER,
	PLACEHOLDER,
	SOURCE_ANCHOR,
	SOURCE_CALL,
	OUT_ANCHOR_DEF,
	OUT_ANCHOR_GET,
	OUT_ANCHOR_NAME,
	OUT_ANCHOR_NAME_NEW,
};

if (require.main === module) main();
