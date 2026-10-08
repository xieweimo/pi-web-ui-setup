#!/usr/bin/env node
/**
 * 修复 pi 会话账本里「非法工具名」的工具调用。
 *
 * 场景：见 scripts/scan-invalid-toolcall-names.js 的头部说明。本脚本把被正文污染
 * 的 function.name 还原为合法名字（依据该调用的 arguments 结构推断），使会话切到
 * openai-codex 后不再触发 400（Invalid 'input[N].name'）。
 *
 * 安全设计：
 *   - 默认 dry-run，只有显式 --apply 才写盘；
 *   - 写盘前把原文件完整备份到 --backup-dir（默认 work/backups/）；
 *   - 幂等：已合法 / 已修复的行不动，重复运行不会二次改动；
 *   - 只改 name 字段，arguments、id、parentId、时间戳全部保持原样；
 *   - 逐行处理：非法行才重新序列化，其余行按原始字节原样写回。
 *
 * 用法：
 *   node scripts/repair-invalid-toolcall-names.js                          # dry-run 全部会话
 *   node scripts/repair-invalid-toolcall-names.js --file <x.jsonl>          # 只处理一个会话文件
 *   node scripts/repair-invalid-toolcall-names.js --apply                   # 真正写盘（先备份）
 *   node scripts/repair-invalid-toolcall-names.js --apply --backup-dir <dir>
 *
 * 退出码：0 = 无待修复或已成功；1 = dry-run 发现待修复；2 = 参数/环境错误。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const LEGAL_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

function parseArgs(argv) {
	const out = { file: null, dir: null, apply: false, backupDir: null, quiet: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--file") out.file = argv[++i];
		else if (a === "--dir") out.dir = argv[++i];
		else if (a === "--apply") out.apply = true;
		else if (a === "--quiet") out.quiet = true;
		else if (a === "--backup-dir") out.backupDir = argv[++i];
		else {
			console.error(`未知参数：${a}`);
			process.exit(2);
		}
	}
	return out;
}

function defaultSessionsDir() {
	const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "sessions");
}

function collectSessionFiles(root) {
	const found = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && e.name.endsWith(".jsonl")) found.push(p);
		}
	};
	walk(root);
	return found;
}

/**
 * 依据 arguments 结构与被污染的 name 文本，推断这个调用本来是什么工具。
 * 只在能给出高置信度判断时才回填真实工具名，否则落到通用占位名。
 */
function inferToolName(badName, args) {
	const a = args && typeof args === "object" && !Array.isArray(args) ? args : null;
	const keys = a ? Object.keys(a) : [];
	const text = String(badName ?? "");

	if (keys.includes("command")) return "bash";
	if (keys.includes("questions")) return "ask_user_question";
	if (keys.includes("edits")) return "edit";
	if (keys.includes("content") && keys.includes("path")) return "write";
	if (keys.includes("steps")) return "plan_update";
	if (keys.includes("matches") || keys.includes("pattern")) return "grep";
	// 无参数调用：从被污染的文本里能看到的线索（这些脏名往往就是当轮正文 + plan 标记）
	if (keys.length === 0) {
		if (/plan:(new|set|clear|active)/.test(text)) return "plan_update";
		return "invalid_tool_call";
	}
	return "invalid_tool_call";
}

/** 原子写盘：先写临时文件再 rename，避免磁盘满/中断把会话账本写半（写半了这个账本就废了）。
 *  写入与 rename 都在 try 内：任一步失败都清临时文件、目标保持原样；不做 fsync（见文档 §8）。 */
function atomicWriteFileSync(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, text, "utf8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
		throw err;
	}
}

/** 扫描并（可选）修复一个文件；返回待修复/已修复明细。 */
function processFile(file, opts) {
	const raw = fs.readFileSync(file, "utf8");
	const lines = raw.split("\n");
	const fixes = [];
	const newLines = lines.map((line, idx) => {
		if (!line.includes("toolCall")) return line;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			return line;
		}
		const m = o.message;
		if (!m || !Array.isArray(m.content)) return line;
		let changed = false;
		for (const c of m.content) {
			if (!c || c.type !== "toolCall") continue;
			const name = String(c.name ?? "");
			if (LEGAL_TOOL_NAME.test(name)) continue;
			const next = inferToolName(name, c.arguments);
			fixes.push({
				line: idx + 1,
				timestamp: o.timestamp ?? null,
				model: m.model ?? null,
				callId: c.id ?? null,
				from: name.length > 120 ? name.slice(0, 120) + "…" : name,
				fromLength: name.length,
				to: next,
			});
			c.name = next;
			changed = true;
		}
		return changed ? JSON.stringify(o) : line;
	});

	if (!fixes.length) return { file, fixes: [], applied: false };

	let backupPath = null;
	if (opts.apply) {
		const backupDir = opts.backupDir ? path.resolve(opts.backupDir) : path.join(process.cwd(), "work", "backups");
		fs.mkdirSync(backupDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		backupPath = path.join(backupDir, `${path.basename(file)}.${stamp}.bak`);
		fs.copyFileSync(file, backupPath);
		atomicWriteFileSync(file, newLines.join("\n"));
	}

	return { file, fixes, applied: opts.apply, backupPath };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	let files;
	if (args.file) {
		const f = path.resolve(args.file);
		if (!fs.existsSync(f)) {
			console.error(`✗ 文件不存在：${f}`);
			process.exit(2);
		}
		files = [f];
	} else {
		const root = args.dir ? path.resolve(args.dir) : defaultSessionsDir();
		if (!fs.existsSync(root)) {
			console.error(`✗ 会话目录不存在：${root}`);
			process.exit(2);
		}
		files = collectSessionFiles(root);
	}

	// 单个文件写盘失败不应拖垮整个批次：记下来最后统一报错退出 2（该文件保持原样）。
	const results = [];
	const failed = [];
	for (const f of files) {
		try {
			const r = processFile(f, args);
			if (r.fixes.length) results.push(r);
		} catch (err) {
			failed.push(`${f}：${err.code || err.message}`);
		}
	}
	const total = results.reduce((n, r) => n + r.fixes.length, 0);

	if (failed.length) {
		console.error(`✗ ${failed.length} 个文件处理失败（这些文件保持原样，其余已处理）：`);
		for (const m of failed) console.error(`  ${m}`);
		process.exit(2);
	}

	if (args.quiet) {
		console.log(`[session-name-repair] ${args.apply ? "已修复" : "待修复"} ${total} 处非法工具名`);
		// 退出码约定（与文件头一致）：--apply 一律 0；dry-run 只有待修复才是 1（无待修复 = 0）。
		process.exit(args.apply || total === 0 ? 0 : 1);
	}

	console.log(`=== 非法工具名修复（${args.apply ? "APPLY" : "dry-run"}）===`);
	if (!total) {
		console.log("✓ 没有需要修复的调用（幂等：重复运行不会改动）");
		process.exit(0);
	}
	for (const r of results) {
		console.log(`\n${r.file}`);
		if (r.applied) console.log(`  备份：${r.backupPath}`);
		for (const x of r.fixes) {
			console.log(`  行${x.line} | ${x.timestamp ?? "-"} | id=${x.callId ?? "-"} | 长度 ${x.fromLength}`);
			console.log(`    ${JSON.stringify(x.from)}`);
			console.log(`    → ${x.to}`);
		}
	}
	console.log(`\n共 ${total} 处${args.apply ? "已修复" : "待修复（加 --apply 执行）"}`);
	process.exit(args.apply ? 0 : 1);
}

main();
