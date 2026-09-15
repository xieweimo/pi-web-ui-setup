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

module.exports = { findWebUiRoot, locateWebUiFile };
