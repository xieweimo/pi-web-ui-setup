#!/usr/bin/env node
/**
 * 取消任务看板垃圾桶按钮的 window.confirm() 同步阻塞。
 * 看板是可随时由 plan_update / [[plan:...]] 重建的会话状态，直接清空比原生确认框
 * 更及时；后者会在高频重绘页面上延迟弹出并冻结主线程。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "plan-board-clear-no-confirm-v1";
const assets = locateWebUiFile("web", "dist", "assets");
const target = assets && fs.existsSync(assets)
	? path.join(assets, fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name)) || "")
	: null;
if (!target || !fs.existsSync(target)) {
	console.error("✗ 找不到 pi-web-ui 的 web/dist/assets/index-*.js");
	process.exit(1);
}
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
	console.log("✓ 看板清空无阻塞补丁已存在");
	process.exit(0);
}
const needle = "l=()=>{window.confirm(`确定要清空当前任务计划看板吗？`)&&$({type:`plan_update`,steps:[]})}";
const replacement = "l=()=>{$({type:`plan_update`,steps:[]})/*plan-board-clear-no-confirm-v1*/}";
const count = source.split(needle).length - 1;
if (count !== 1) {
	console.error(`✗ 看板清空锚点命中 ${count} 次，拒绝模糊替换`);
	process.exit(2);
}
source = source.replace(needle, replacement);
fs.writeFileSync(target, source, "utf8");
console.log("✓ 已移除任务看板清空的同步 confirm() 阻塞");
