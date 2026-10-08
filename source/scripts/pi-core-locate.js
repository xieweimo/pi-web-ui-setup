/**
 * 定位 pi 内核（pi-coding-agent / pi-agent-core / pi-ai）的实际安装位置。
 *
 * 为什么需要它：pi 内核补丁（如 patches/patch-pi-invalid-toolcall-names.js）改的是
 * node_modules 里的产物文件，而这些产物在不同机器上可能有 1~3 份副本：
 *   1) pi-web-ui 内嵌副本  <pi-web-ui>/node_modules/@earendil-works/pi-coding-agent  ← 网页版实际加载
 *   2) 全局 pi CLI 副本    %APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent
 *   3) 源码项目副本        <repo>/projects/pi-web-ui-source/node_modules/@earendil-works/pi-coding-agent
 * 只补一份等于没补（改到没人加载的那份），所以补丁与校验脚本必须共用本模块。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");

/** 所有存在 package.json 的 pi-coding-agent 安装根。 */
function piCodingAgentRoots() {
	// 测试/受控环境覆盖：必须同时显式开 PI_PATCH_TEST=1 才接受 PI_CODING_AGENT_ROOTS。
	// 双开关的原因：PI_CODING_AGENT_ROOTS 是全局限，环境里一旦残留（用户/CI 设过），
	// 补丁与 check-pi-web-ui-patches.js（共用本模块）会**同时**缩窄到那几份 —— 检查照样全绿、
	// 其余副本漏补却无人察觉。只返回存在的目录。
	const rawOverride = process.env.PI_CODING_AGENT_ROOTS;
	if (rawOverride && process.env.PI_PATCH_TEST !== "1") {
		console.error("⚠ 检测到 PI_CODING_AGENT_ROOTS 但未设 PI_PATCH_TEST=1，已忽略该覆盖（防止补丁/校验漏掉其他 pi 副本）");
	}
	const override = process.env.PI_PATCH_TEST === "1" ? rawOverride : "";
	if (override) {
		const seen = new Set();
		return override
			.split(/[;\n]/)
			.map((s) => s.trim())
			.filter(Boolean)
			.map((p) => path.resolve(p))
			.filter((p) => fs.existsSync(path.join(p, "package.json")) && !seen.has(p) && (seen.add(p), true));
	}
	const out = [];
	const add = (p) => {
		if (p && fs.existsSync(path.join(p, "package.json")) && !out.includes(p)) out.push(p);
	};
	try {
		const { findWebUiRoot } = require("./pi-web-ui-locate.js");
		const webRoot = findWebUiRoot();
		if (webRoot) add(path.join(webRoot, "node_modules", "@earendil-works", "pi-coding-agent"));
	} catch {
		/* locate 不可用时走下面的兜底 */
	}
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "install.json"), "utf8"));
		if (cfg.nodeDir) {
			add(path.join(cfg.nodeDir, "node_modules", "pi-web-ui", "node_modules", "@earendil-works", "pi-coding-agent"));
			add(path.join(cfg.nodeDir, "node_modules", "@earendil-works", "pi-coding-agent"));
		}
	} catch {
		/* 非便携安装 */
	}
	const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
	add(path.join(roaming, "npm", "node_modules", "pi-web-ui", "node_modules", "@earendil-works", "pi-coding-agent"));
	add(path.join(roaming, "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
	add(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
	add(path.join(ROOT, "projects", "pi-web-ui-source", "node_modules", "@earendil-works", "pi-coding-agent"));
	return out;
}

/** 从某个目录向上查找 @earendil-works/<pkg>（npm 会提升依赖，不能只看直接子目录）。 */
function resolvePiDep(startDir, pkg) {
	let dir = startDir;
	for (;;) {
		const cand = path.join(dir, "node_modules", "@earendil-works", pkg);
		if (fs.existsSync(path.join(cand, "package.json"))) return cand;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

module.exports = { ROOT, piCodingAgentRoots, resolvePiDep };
