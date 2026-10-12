#!/usr/bin/env node
/**
 * 任务看板守卫：一次完成补丁修复与真实行为测试。
 *
 * node scripts/manage-plan-board.mjs          # 修复并验收
 * node scripts/manage-plan-board.mjs --check  # 只验收，不修改安装包
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { findWebUiRoot, packageVersion } = require("./pi-web-ui-locate.js");
const checkOnly = process.argv.includes("--check");
const webRoot = findWebUiRoot();

function stop(message, code = 1) {
	console.error(`✗ 任务看板守卫失败：${message}`);
	process.exit(code);
}
function run(label, file, args = []) {
	const result = spawnSync(process.execPath, [file, ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 60000,
	});
	const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
	if (output) console.log(output);
	if (result.error) stop(`${label} 无法启动：${result.error.message}`);
	if (result.status !== 0) stop(`${label} 退出码 ${result.status ?? 1}`, result.status === 2 ? 2 : 1);
}

if (!webRoot || !fs.existsSync(path.join(webRoot, "dist", "server", "agent-service.js"))) {
	stop("找不到完整的 pi-web-ui 安装包", 2);
}
console.log(`任务看板守卫：${checkOnly ? "只校验" : "修复并校验"}`);
if (!checkOnly) {
	run("应用看板标记补丁", path.join(root, "patches", "patch-pi-web-ui-plan-marker.js"));
	run("应用看板清空补丁", path.join(root, "patches", "patch-pi-web-ui-plan-board-clear.js"));
}
const assets = path.join(webRoot, "web", "dist", "assets");
const entry = fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name));
if (!entry) stop("找不到看板前端入口 bundle");
const bundle = fs.readFileSync(path.join(assets, entry), "utf8");
if (!bundle.includes("plan-board-clear-no-confirm-v1")) stop("清空按钮仍可能弹同步确认框");
const webVersion = packageVersion("pi-web-ui").split(".").map(Number);
if (webVersion[0] >= 1 || webVersion[1] >= 104) {
	if (!bundle.includes("plan-board-clear-always-visible-v2")) stop("清空按钮仍被藏在折叠区");
	const action = bundle.indexOf("plan-board-actions");
	const visible = bundle.indexOf("plan-board-clear-always-visible-v2", action);
	const folded = bundle.indexOf("plan-board-clean-handoff", action);
	if (action < 0 || visible < action || folded < visible || folded - visible > 500) stop("清空按钮常驻操作区结构未通过校验");
}
run("看板行为测试", path.join(root, "scripts", "test-pi-web-ui-plan-marker.mjs"));
console.log("✓ 任务看板守卫通过：错误格式已拒绝，状态、快照和重启恢复均已验证");
