#!/usr/bin/env node
/**
 * pi-web-ui 补丁「秒级」校验（替代不了真实页面自检，但能把 90% 的失败提前拦下）
 *
 * 只做三件事，都不需要重启服务、不需要浏览器：
 *   1. 版本对齐：pi-web-ui 版本 + pi 版本 → 必须存在同名 profile；
 *   2. 补丁落地：按 profile 逐项检查「标记字符串是否已在目标文件里」；
 *      缺失时**才**实际执行该补丁，用退出码区分「刚补上(0)」和「锚点失效(2)」；
 *   3. 产物健康：压缩 bundle 语法检查（node --check）、marker 断言、index.html 注入。
 *
 * 用法：
 *   node scripts/check-pi-web-ui-patches.js            # 校验（缺失才补）
 *   node scripts/check-pi-web-ui-patches.js --quiet    # 只输出失败项与汇总
 *
 * 退出码：0 全部通过 / 1 有失败项 / 2 profile 未找到
 *
 * 与真实页面自检的分工：
 *   本脚本 = 「补丁打上了吗、bundle 还是合法 JS 吗」，秒级；
 *   scripts/check-codex-usage.js = 「浏览器里真的渲染出按钮和状态栏了吗」，十秒级。
 *   两者都要跑，前者通过不代表界面正确。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findWebUiRoot } = require("./pi-web-ui-locate.js");

const ROOT = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

/**
 * 每个补丁落地后的「特征字符串」断言表。
 * file: server = dist/server 下的服务端产物；web = web/dist/assets 下的前端 bundle；html = web/dist/index.html
 * marker 可以是字符串或字符串数组：数组内每一项都必须命中才算已落地。
 * 新增补丁时必须同时补进这张表，否则校验会漏项（漏项按失败处理）。
 */
const MARKERS = {
	"patch-pi-web-ui-usage-cost.js": { file: "server", marker: "usageCost: typeof m.usage?.cost?.total" },
	"patch-pi-web-ui-plugin-live-model.js": { file: "server", marker: "plugin-live-model-patch" },
	"patch-pi-web-ui-hide-forked-sessions.js": { file: "server", marker: "hide-forked-sessions" },
	"patch-pi-web-ui-permanent-project-ignore.js": { file: "server", marker: "managed-recent-project-actions-v3" },
	"patch-pi-web-ui-recovery-ui.js": { file: "html", marker: "pi-recovery-ui-v2" },
	"patch-pi-web-ui-quick-phrase-queue.js": { file: "web", marker: "quick-chip-group" },
	"patch-pi-web-ui-topbar-menu-buttons.js": { file: "web", marker: "topbar-menu-buttons-patch" },
	"patch-pi-web-ui-plugin-topbar-cache.js": { file: "web", marker: "plugin-topbar-cache-patch-v2" },
	"patch-pi-web-ui-plan-board-clear.js": { file: "web", marker: "plan-board-clear-no-confirm-v1" },
	"patch-pi-web-ui-plan-marker.js": { file: "server", marker: ["plan-inline-marker-v2", "plan-marker-snapshot-v2", "plan-marker-restore-v2"] },
	"patch-pi-web-ui-dangling-tool-calls.js": { file: "server", marker: "dangling-active-chain-filter-v2" },
	"apply-stop-button.ps1": { file: "html", marker: "stopPulse" },
};

/**
 * 已退役的补丁：自某个 pi-web-ui 版本起上游内建了等价能力，不再需要打进产物。
 * 它们仍保留在本表之外的文件里（旧版本 profile 还需要），但**不得再列入新版本 profile**。
 */
const RETIRED = {
	"patch-pi-web-ui-quick-phrase-queue.js": "0.94.1 起用上游内建的右键排队（chip 的 onContextMenu），自加的 ⏳ 按钮已移除（--remove 可清除已注入的）",
	"patch-pi-web-ui-recovery-ui.js": "0.94.1 起不再注入：顶栏「重连」插件在断连时直连 watchdog（127.0.0.1:8790），能力已覆盖浮层（用户确认删除；可用 --remove 清除已注入的块）",
	"patch-pi-web-ui-usage-cost.js": "0.94.1 起上游 serialize 自己下发 usageCost（缺省 undefined，与本补丁的 null 对插件等价）",
	"patch-pi-web-ui-hide-forked-sessions.js": "0.94.1 起上游 agent-service 自己按 parentSessionPath 去重 fork 链尾",
	"patch-pi-web-ui-permanent-project-ignore.js": "0.94.1 起上游 client-state 自己维护全局 removedProjects 与打开即清标记",
};

const results = [];
const fail = (name, detail) => results.push({ ok: false, name, detail });
const pass = (name, detail) => results.push({ ok: true, name, detail });

function readJson(p) {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

/** 读某个包的版本号：包可能在 pi-web-ui 自己的 node_modules 下（bundled），也可能在全局 npm 目录。 */
function packageVersion(name) {
	const webRoot = findWebUiRoot();
	const candidates = [
		path.join(webRoot || "", "node_modules", ...name.split("/"), "package.json"),
		path.join(process.env.APPDATA || "", "npm", "node_modules", ...name.split("/"), "package.json"),
	];
	for (const c of candidates) {
		const j = readJson(c);
		if (j?.version) return j.version;
	}
	return null;
}

function webFile(kind) {
	const webRoot = findWebUiRoot();
	if (!webRoot) return null;
	if (kind === "html") return path.join(webRoot, "web", "dist", "index.html");
	if (kind === "server") {
		const dir = path.join(webRoot, "dist", "server");
		if (!fs.existsSync(dir)) return null;
		const files = [];
		const walk = (current) => {
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
			}
		};
		walk(dir);
		return files;
	}
	const dir = path.join(webRoot, "web", "dist", "assets");
	if (!fs.existsSync(dir)) return null;
	return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
}

function readAllOf(kind) {
	const f = webFile(kind);
	if (!f) return "";
	const files = Array.isArray(f) ? f : [f];
	return files.map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "")).join("\n");
}

function runPatch(file) {
	const full = path.join(ROOT, file);
	if (!fs.existsSync(full)) return { code: 127, out: "文件不存在" };
	const cmd = file.endsWith(".ps1") ? "powershell" : process.execPath;
	const args = file.endsWith(".ps1")
		? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", full]
		: [full];
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000 });
	return { code: r.status ?? 1, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

// ---- 1. 版本与 profile ----
const webRoot = findWebUiRoot();
if (!webRoot) {
	console.error("✗ 找不到 pi-web-ui 安装目录（便携 install.json 与 npm 全局目录都没有）");
	process.exit(2);
}
const webVer = readJson(path.join(webRoot, "package.json"))?.version ?? null;
const piVer = packageVersion("@earendil-works/pi-coding-agent");
if (!webVer || !piVer) {
	console.error(`✗ 版本识别失败：pi-web-ui=${webVer} pi=${piVer}`);
	process.exit(2);
}
const profileRel = path.join("configs", "pi-web-ui-profiles", `pi-${piVer}_web-${webVer}.json`);
const profile = readJson(path.join(ROOT, profileRel));
if (!profile) {
	console.error(`✗ 未找到匹配 profile：${profileRel}`);
	console.error("  升级 pi / pi-web-ui 后必须新建对应版本档案。");
	process.exit(2);
}
pass("profile", `pi-${piVer}_web-${webVer}.json（${profile.patches.length} 项）`);

// ---- 2. 压缩产物语法（只查被补丁改过的文件：全量查 85 个文件白耗 5 秒）----
const markersByKind = new Map();
for (const spec of Object.values(MARKERS)) {
	if (!markersByKind.has(spec.file)) markersByKind.set(spec.file, []);
	markersByKind.get(spec.file).push(...(Array.isArray(spec.marker) ? spec.marker : [spec.marker]));
}
for (const [kind, markers] of markersByKind) {
	if (kind === "html") continue; // index.html 不是 JS，无需语法检查
	for (const p of webFile(kind) ?? []) {
		if (!fs.existsSync(p)) continue;
		const text = fs.readFileSync(p, "utf8");
		if (!markers.some((m) => text.includes(m))) continue; // 没被补丁动过，不查
		const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8", timeout: 30000 });
		if (r.status === 0) pass(`syntax ${kind}`, path.basename(p));
		else fail(`syntax ${kind}`, `${path.basename(p)} 不是合法 JS：${(r.stderr || "").split("\n")[0]}`);
	}
}

// ---- 3. 逐项校验补丁 ----
const uncovered = [];
for (const rel of profile.patches) {
	const base = path.basename(rel);
	if (RETIRED[base]) {
		fail(`patch ${base}`, `已退役（${RETIRED[base]}），不应再列入 profile`);
		continue;
	}
	const spec = MARKERS[base];
	if (!spec) {
		uncovered.push(rel);
		fail(`patch ${base}`, "未登记到本脚本的特征字符串表，无法校验");
		continue;
	}
	const wanted = Array.isArray(spec.marker) ? spec.marker : [spec.marker];
	const before = readAllOf(spec.file);
	if (wanted.every((m) => before.includes(m))) {
		pass(`patch ${base}`, "已落地");
		continue;
	}
	// 缺失才实际执行：0=刚补上，2=锚点失效（源码变了）
	const r = runPatch(rel);
	if (r.code === 0) {
		// 补丁可能只命中一半（退出 0 却只改了一处）：重打后必须逐项复验。
		const after = readAllOf(spec.file);
		const stillMissing = wanted.filter((m) => !after.includes(m));
		if (stillMissing.length === 0) pass(`patch ${base}`, "已重新应用");
		else fail(`patch ${base}`, `重新应用后仍缺少标记：${stillMissing.join(", ")}`);
	} else if (r.code === 2) {
		fail(`patch ${base}`, "锚点失效：pi-web-ui 源码已变化，必须适配");
	} else {
		fail(`patch ${base}`, `退出码 ${r.code}：${r.out.split("\n").slice(-1)[0]}`);
	}
}
// 不比对「profile 项数 == 断言表项数」：断言表是跨版本的超集，各版本 profile 因补丁
// 退役/新增而项数不同（如 0.94.1 退役了 fork 去重与最近项目两项）。真正要守的是
// 「profile 里每一项都能被校验」——上面逐项检查已覆盖（未登记者直接判失败）。

// plan marker 的真实装配链：只检查 marker-service 的 ctx.host 不够，AgentService
// 创建 MarkerService 时也必须传入同一个 PlanManager，否则界面会提示服务不可用。
const agentServiceFile = path.join(webRoot, "dist", "server", "agent-service.js");
const agentServiceText = fs.existsSync(agentServiceFile) ? fs.readFileSync(agentServiceFile, "utf8") : "";
if (/this\.markerSvc = new MarkerService\(\{[\s\S]*?planManager: this\.planManager,[\s\S]*?flushSnapshot: \(\) => this\.flushSnapshot\(\),/.test(agentServiceText)) {
	pass("plan marker host", "AgentService 已注入 planManager");
} else {
	fail("plan marker host", "AgentService 未向 MarkerService 注入 planManager");
}

// ---- 4. 汇总 ----
const failed = results.filter((r) => !r.ok);
if (!QUIET) {
	for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name} — ${r.detail}`);
} else if (failed.length) {
	for (const r of failed) console.log(`✗ ${r.name} — ${r.detail}`);
}
console.log(
	`\n${failed.length === 0 ? "✓ 全部通过" : `✗ ${failed.length} 项失败`}：` +
		`pi-web-ui ${webVer} / pi ${piVer}，共 ${results.length} 项检查，` +
		`profile ${profile.patches.length} 个补丁${uncovered.length ? `（${uncovered.length} 项未覆盖）` : ""}`,
);
console.log("提示：本脚本只校验补丁落地，界面是否真的渲染出来请再跑 node scripts/check-codex-usage.js");
process.exit(failed.length === 0 ? 0 : 1);
