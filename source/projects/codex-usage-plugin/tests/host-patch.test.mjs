/**
 * host-patch/apply.cjs 端到端测试。
 *
 * 不碰本机真实的 pi-web-ui：把它的产物复制到临时目录，按锚点表反向还原成“未打补丁”的样子，
 * 再让脚本去打，最后逐字节比对结果与真实（已手工打过补丁的）产物是否完全一致。
 *
 * 运行：node tests/host-patch.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = import.meta.dirname;
const { findWebUiRoot, distFile, EDITS } = require(path.join(here, "../host-patch/apply.cjs"));

const realRoot = findWebUiRoot();
assert.ok(realRoot, "找不到本机 pi-web-ui（本测试需要它的产物作为夹具来源）");
assert.ok(EDITS.length === 6, `锚点表应为 6 处，实际 ${EDITS.length}`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-hostpatch-"));
const kinds = [...new Set(EDITS.map((e) => e.kind))];
const realText = {};
const pristineText = {};

// 1) 复制真实产物，并（必要时）反向还原成未打补丁版本
for (const kind of kinds) {
	realText[kind] = fs.readFileSync(distFile(realRoot, kind), "utf8");
	let text = realText[kind];
	for (const e of EDITS.filter((x) => x.kind === kind)) {
		if (!text.includes(e.applied)) continue; // 本机没打过 → 这份复制品已经是“未打补丁”
		const n = text.split(e.replacement).length - 1;
		assert.equal(n, 1, `反向还原 ${e.label}：replacement 命中 ${n} 次（应为 1）`);
		text = text.replace(e.replacement, e.needle);
	}
	pristineText[kind] = text;
}
for (const kind of kinds) {
	fs.mkdirSync(path.dirname(distFile(tmpRoot, kind)), { recursive: true });
	fs.writeFileSync(distFile(tmpRoot, kind), pristineText[kind], "utf8");
}
fs.writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "pi-web-ui", version: "0.0.0-fixture" }), "utf8");

const run = (args = [], env = {}) =>
	spawnSync(process.execPath, [path.join(here, "../host-patch/apply.cjs"), ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_WEB_UI_DIR: tmpRoot, ...env },
	});

try {
	// 2) dry-run：应报 6 处「已应用」、不改盘
	const before = kinds.map((k) => fs.readFileSync(distFile(tmpRoot, k), "utf8"));
	const dry = run(["--dry-run"]);
	assert.equal(dry.status, 0, `dry-run 退出码应为 0，实际 ${dry.status}\n${dry.stdout}${dry.stderr}`);
	assert.match(dry.stdout, /会修改 3 个文件/, "dry-run 应报告 3 个文件待改");
	assert.deepEqual(kinds.map((k) => fs.readFileSync(distFile(tmpRoot, k), "utf8")), before, "dry-run 不得改盘");

	// 3) 真跑：6 处全部「已应用」，且结果与真实产物逐字节一致
	const applied = run();
	assert.equal(applied.status, 0, `应用退出码应为 0，实际 ${applied.status}\n${applied.stdout}${applied.stderr}`);
	assert.equal((applied.stdout.match(/已应用/g) || []).length, 6, "应报告 6 处已应用");
	for (const kind of kinds) {
		assert.equal(
			fs.readFileSync(distFile(tmpRoot, kind), "utf8"),
			realText[kind],
			`${kind} 补丁结果与本机真实产物不一致（等价性失败）`,
		);
	}

	// 4) 幂等：再跑一次应全部「已存在」且 0 改动
	const again = run();
	assert.equal(again.status, 0);
	assert.equal((again.stdout.match(/已存在/g) || []).length, 6, "第二次应报告 6 处已存在");
	assert.match(again.stdout, /已是最新，无需改动/);

	// 5) 锚点失配：把夹具的锚点真改坏（改针内部一个标识符）后必须退出码 2，且**不写盘**
	const brokenKind = EDITS[0].kind;
	for (const kind of kinds) fs.writeFileSync(distFile(tmpRoot, kind), pristineText[kind], "utf8");
	const broken = pristineText[brokenKind].replace("    readConversationForPlugins() {", "    readConversationForPluginsDrifted() {");
	assert.notEqual(broken, pristineText[brokenKind], "夹具必须真的被改坏（否则这个用例测不到东西）");
	fs.writeFileSync(distFile(tmpRoot, brokenKind), broken, "utf8");
	const mismatch = run();
	assert.equal(mismatch.status, 2, `锚点失配应退出码 2，实际 ${mismatch.status}\n${mismatch.stdout}${mismatch.stderr}`);
	assert.match(mismatch.stderr, /锚点失配/);
	for (const kind of kinds.filter((k) => k !== brokenKind)) {
		assert.equal(fs.readFileSync(distFile(tmpRoot, kind), "utf8"), pristineText[kind], "锚点失配时不得写入任何文件");
	}

	// 6) 产物缺失：干净目录应退出码 1
	const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-hostpatch-empty-"));
	fs.writeFileSync(path.join(emptyRoot, "package.json"), "{}", "utf8");
	const missing = run([], { PI_WEB_UI_DIR: emptyRoot });
	assert.equal(missing.status, 1, `产物缺失应退出码 1，实际 ${missing.status}`);
	assert.match(missing.stderr, /产物缺失/);
	fs.rmSync(emptyRoot, { recursive: true, force: true });

	console.log("✓ host-patch 端到端测试通过（等价性 / dry-run / 幂等 / 失配不写盘 / 产物缺失）");
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
