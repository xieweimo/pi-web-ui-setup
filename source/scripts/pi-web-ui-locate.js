/**
 * 定位 pi-web-ui 的安装目录。
 *
 * 两种安装布局：
 *   1) 便携安装（学校机房等无管理员环境）：npm 全局前缀 = 便携 Node 目录，
 *      包位于 <root>/node/node_modules/pi-web-ui，由 install.json 记录；
 *   2) 普通全局安装：%APPDATA%/npm/node_modules/pi-web-ui。
 *
 * 补丁脚本必须两者都认，否则便携安装下会报「找不到 pi-web-ui 文件」。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function candidateRoots() {
	const out = [];
	const root = path.resolve(__dirname, "..");
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(root, "install.json"), "utf8"));
		if (cfg.nodeDir) out.push(path.join(cfg.nodeDir, "node_modules", "pi-web-ui"));
		if (cfg.shim) out.push(path.join(path.dirname(cfg.shim), "node_modules", "pi-web-ui"));
	} catch {
		/* 非便携安装，或 install.json 不存在 */
	}
	const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
	out.push(path.join(roaming, "npm", "node_modules", "pi-web-ui"));
	out.push(path.join(root, "node_modules", "pi-web-ui"));
	return out;
}

/** pi-web-ui 包目录，找不到返回 null。 */
function findWebUiRoot() {
	for (const c of candidateRoots()) {
		if (fs.existsSync(path.join(c, "package.json"))) return c;
	}
	return null;
}

/** pi-web-ui 包内的文件路径，找不到返回 null。 */
function locateWebUiFile(...rel) {
	const root = findWebUiRoot();
	return root ? path.join(root, ...rel) : null;
}

/**
 * 读某个包的版本号，**优先自带副本、再全局**。
 *
 * 为什么顺序很重要：pi-web-ui 的依赖范围是 `>=0.85.1`，`npm i -g pi-web-ui` 会把**最新**的
 * pi-coding-agent 装到 `<pi-web-ui>/node_modules/` 下（自带副本）；而机器上可能另有一份
 * 更旧的全局 CLI 副本。服务实际加载的是自带那份（`resolve-global-sdk` 也会跟随更新的），
 * 所以版本档案必须以自带副本为准 —— 否则检查脚本与应用脚本会各算一个版本，谁也跑不通。
 */
function packageVersion(name) {
	const root = findWebUiRoot();
	if (!root) return null;
	const parts = name.split("/");
	const candidates = [
		// pi-web-ui 自身不在自己的 node_modules 里。
		...(name === "pi-web-ui" ? [path.join(root, "package.json")] : []),
		path.join(root, "node_modules", ...parts, "package.json"),
		// npm 可能把 pi 提升到与 pi-web-ui 同级；便携 Node 的前缀不是 %APPDATA%/npm。
		path.join(path.dirname(root), ...parts, "package.json"),
		path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", ...parts, "package.json"),
	];
	for (const c of candidates) {
		try {
			const j = JSON.parse(fs.readFileSync(c, "utf8"));
			if (j?.version) return j.version;
		} catch {
			/* 该副本不存在：试下一个 */
		}
	}
	return null;
}

module.exports = { findWebUiRoot, locateWebUiFile, packageVersion };
