#!/usr/bin/env node
/**
 * 取消任务看板垃圾桶按钮的 window.confirm() 同步阻塞。
 * 看板是可随时由 plan_update / [[plan:...]] 重建的会话状态，直接清空比原生确认框
 * 更及时；后者会在高频重绘页面上延迟弹出并冻结主线程。
 *
 * 本补丁要打**两个**目标，少一个都会出现「我明明修过，怎么又回去了」：
 *
 *   1. npm 全局 dist 的压缩 bundle —— 生产（8787）加载的是它；
 *   2. `projects/pi-web-ui-source/web/src/components/PlanBoard.tsx` —— **dev（5173）
 *      是 vite 现场编译源码**，根本不读 web/dist，只改 bundle 对它完全无效。
 *
 * 2026-09-29 实际踩过：bundle 早已修好、8787 正常，但用户在 5173 上仍弹确认框且卡，
 * 因为源码目标从来没被打过。
 *
 * 幂等（两侧各自判 marker）；锚点失效退出码 2，不做模糊替换。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "plan-board-clear-no-confirm-v1";
const ROOT = path.resolve(__dirname, "..");

/** 任一目标锚点失效 → 2；有目标完全找不到 → 1；全好 → 0。 */
let exitCode = 0;
const note = (code, msg) => {
	console.log(msg);
	if (code > exitCode) exitCode = code;
};

// ---------------------------------------------------------------------------
// 1) 生产：npm 全局 web/dist/assets/index-*.js
// ---------------------------------------------------------------------------
function patchBundle() {
	const assets = locateWebUiFile("web", "dist", "assets");
	const target = assets && fs.existsSync(assets)
		? path.join(assets, fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name)) || "")
		: null;
	if (!target || !fs.existsSync(target)) {
		note(1, "✗ 找不到 pi-web-ui 的 web/dist/assets/index-*.js");
		return;
	}
	const source = fs.readFileSync(target, "utf8");
	if (source.includes(marker)) {
		note(0, "✓ 看板清空无阻塞补丁已存在（生产 bundle）");
		return;
	}
	// 锛點故意不含压缩后的变量名：0.96.1 是 `l=()=>{…}`、0.99.0 变成 `v=()=>{…}`，
	// 绑变量名等于上游每次重压缩都要改补丁。这里只匹配确认框调用本身（仍然要求唯一命中，
	// 不做模糊替换）。
	const needle = "window.confirm(`确定要清空当前任务计划看板吗？`)&&$({type:`plan_update`,steps:[]})";
	const replacement = "$({type:`plan_update`,steps:[]})/*plan-board-clear-no-confirm-v1*/";
	const count = source.split(needle).length - 1;
	if (count !== 1) {
		note(2, `✗ 生产 bundle 看板清空锚点命中 ${count} 次，拒绝模糊替换`);
		return;
	}
	fs.writeFileSync(target, source.replace(needle, replacement), "utf8");
	note(0, "✓ 已移除任务看板清空的同步 confirm() 阻塞（生产 bundle）");
}

// ---------------------------------------------------------------------------
// 2) dev：source checkout 的 React 源码（vite 5173 直接 serve 它）
// ---------------------------------------------------------------------------
function patchDevSource() {
	const target = path.join(ROOT, "projects", "pi-web-ui-source", "web", "src", "components", "PlanBoard.tsx");
	if (!fs.existsSync(target)) {
		note(0, "· 未找到 source checkout，跳过 dev 源码补丁（只装了生产包的机器属正常）");
		return;
	}
	const raw = fs.readFileSync(target, "utf8");
	if (raw.includes(marker)) {
		note(0, "✓ 看板清空无阻塞补丁已存在（dev 源码 PlanBoard.tsx）");
		return;
	}
	const needle = `\tconst handleClearPlan = () => {
\t\tif (window.confirm("确定要清空当前任务计划看板吗？")) {
\t\t\tappSend({
\t\t\t\ttype: "plan_update",
\t\t\t\tsteps: [],
\t\t\t});
\t\t}
\t};`;
	const replacement = `\tconst handleClearPlan = () => {
\t\t// ${marker}：看板可随时由 plan_update / [[plan:...]] 重建，直接清空，
\t\t// 不再弹同步 confirm —— 它会在高频重绘的看板上延迟弹出并冻结主线程。
\t\tappSend({
\t\t\ttype: "plan_update",
\t\t\tsteps: [],
\t\t});
\t};`;
	// 源码是 CRLF（上游仓库检出），统一按 LF 匹配，写回时还原原行尾，
	// 否则 needle 的 `\n` 永远匹配不上 `\r\n`（命中 0 次 → 误报锚点失效）。
	const crlf = raw.includes("\r\n");
	const source = crlf ? raw.replace(/\r\n/g, "\n") : raw;
	const count = source.split(needle).length - 1;
	if (count !== 1) {
		note(2, `✗ dev 源码看板清空锚点命中 ${count} 次，拒绝模糊替换（上游可能改了实现）`);
		return;
	}
	const patched = source.replace(needle, replacement);
	fs.writeFileSync(target, crlf ? patched.replace(/\n/g, "\r\n") : patched, "utf8");
	note(0, "✓ 已移除任务看板清空的同步 confirm() 阻塞（dev 源码 PlanBoard.tsx，vite 热更新即时生效）");
}

patchBundle();
patchDevSource();

if (exitCode === 2) console.error("✗ 锚点失效：pi-web-ui 源码已变化，必须适配当前版本");
process.exit(exitCode);
