#!/usr/bin/env node
/**
 * 把本仓库 projects/ 下的插件部署到 pi-web-ui 的数据目录。
 *
 * 源：<本仓库>/projects/<目录名>/（以 -plugin 结尾的目录，id 取自其中的 manifest.json）
 * 目标：<dataDir>/plugins/<id>/（默认 ~/.pi-web/plugins/<id>）
 *
 * 用法：node scripts/install-plugins.js [--data-dir <dir>] [--dry-run] [--only <id,id>]
 * 说明：只复制 manifest.json / index.mjs / client/ / README.md，跳过 tests/；
 *      目标目录里已有的 config.json（用户的本地配置）不会被覆盖，只在缺失时补一份。
 *      插件目录与 pi-web-ui 包目录分离 —— npm 升级 pi-web-ui 不会动它。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dataDirFlag = args.indexOf("--data-dir");
const onlyFlag = args.indexOf("--only");

const ROOT = path.join(__dirname, "..");
const SRC_ROOT = path.join(ROOT, "projects");
const DATA_DIR =
	(dataDirFlag >= 0 ? args[dataDirFlag + 1] : process.env.PI_WEB_DATA_DIR) ||
	path.join(os.homedir(), ".pi-web");
const ONLY = new Set(
	(onlyFlag >= 0 ? String(args[onlyFlag + 1] ?? "") : "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);
/** 随包分发的文件（config.json 属于目标目录的本地配置，不从源带过去）。 */
const COPY = ["manifest.json", "index.mjs", "README.md", "client"];

function log(msg) {
	console.log(msg);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 插件源目录列表：projects/*-plugin。 */
function pluginSources() {
	if (!fs.existsSync(SRC_ROOT)) return [];
	return fs
		.readdirSync(SRC_ROOT, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name.endsWith("-plugin"))
		.map((e) => path.join(SRC_ROOT, e.name))
		.filter((dir) => fs.existsSync(path.join(dir, "manifest.json")));
}

/** 递归复制（保持目录结构）。 */
function copyRecursive(src, dest) {
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true });
		for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dest, name));
		return;
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
}

const sources = pluginSources();
if (!sources.length) {
	console.error("✗ projects/ 下没有找到任何 *-plugin 目录（含 manifest.json）");
	process.exit(1);
}

let installed = 0;
for (const src of sources) {
	const manifest = readJson(path.join(src, "manifest.json"));
	const id = typeof manifest?.id === "string" ? manifest.id.trim() : "";
	if (!id) {
		console.error(`✗ ${path.basename(src)}：manifest.json 没有合法 id，跳过`);
		continue;
	}
	if (ONLY.size && !ONLY.has(id)) continue;

	const dest = path.join(DATA_DIR, "plugins", id);
	log(`${dryRun ? "[dry-run] " : ""}${id}：${src} → ${dest}`);
	if (dryRun) {
		installed += 1;
		continue;
	}
	fs.mkdirSync(dest, { recursive: true });
	for (const item of COPY) {
		const from = path.join(src, item);
		if (!fs.existsSync(from)) continue;
		copyRecursive(from, path.join(dest, item));
	}
	// config.json：只在目标缺失时写一份，指向本仓库根（piwork-tools 用它找同步脚本）。
	// 已存在就原样保留 —— 那是用户的本地配置，安装/升级都不该覆盖。
	const cfgFile = path.join(dest, "config.json");
	if (!fs.existsSync(cfgFile)) {
		fs.writeFileSync(cfgFile, JSON.stringify({ repoRoot: ROOT }, null, 2) + "\n", "utf8");
		log(`  + config.json（repoRoot=${ROOT}）`);
	} else {
		const cfg = readJson(cfgFile);
		if (cfg && typeof cfg.repoRoot === "string" && !fs.existsSync(path.join(cfg.repoRoot, "scripts"))) {
			log(`  ! config.json 里的 repoRoot 已失效：${cfg.repoRoot}（插件视图里会提示）`);
		}
	}
	installed += 1;
}

log(`完成：${installed} 个插件 → ${path.join(DATA_DIR, "plugins")}（刷新浏览器即生效）`);
