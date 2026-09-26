#!/usr/bin/env node
/**
 * 插件化迁移第 0 批：采集可追溯基线。
 *
 * 只读取版本、启用补丁、受控源码/安装入口 hash 与上游 clone 的语义 diff；
 * 不修改 pi-web-ui、插件目录、profile 或用户数据。
 *
 * 用法：node scripts/capture-pi-web-ui-migration-baseline.js
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findWebUiRoot } = require("./pi-web-ui-locate.js");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "configs", "pi-web-ui-migration-baseline.json");
const REPORT = path.join(ROOT, "docs", "pi-web-ui-插件化迁移基线.md");

function sha256(file) {
	if (!fs.existsSync(file)) return null;
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileInfo(file) {
	if (!fs.existsSync(file)) return { exists: false, sha256: null, bytes: 0 };
	const stat = fs.statSync(file);
	return { exists: true, sha256: sha256(file), bytes: stat.size };
}

function json(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function run(command, args) {
	const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", timeout: 30000 });
	return {
		code: result.status ?? 1,
		stdout: (result.stdout || "").trim(),
		stderr: (result.stderr || "").trim(),
	};
}

function packageVersion(name, webRoot) {
	const candidates = [
		path.join(webRoot || "", "node_modules", ...name.split("/"), "package.json"),
		path.join(process.env.APPDATA || "", "npm", "node_modules", ...name.split("/"), "package.json"),
	];
	for (const candidate of candidates) {
		const value = json(candidate);
		if (value?.version) return value.version;
	}
	return null;
}

function pluginEntrypoints(sourceDir, installedDir) {
	const files = ["manifest.json", "index.mjs", path.join("client", "entry.mjs")];
	const result = {};
	for (const rel of files) {
		const source = fileInfo(path.join(sourceDir, rel));
		const installed = fileInfo(path.join(installedDir, rel));
		result[rel.replaceAll("\\", "/")] = {
			source,
			installed,
			// 纯 manifest 插件合法地没有服务端/客户端入口；两边都不存在也应视为一致。
			matches: source.exists === installed.exists && (!source.exists || source.sha256 === installed.sha256),
		};
	}
	return result;
}

function markdown(snapshot) {
	const lines = [
		"# 插件化迁移第 0 批基线",
		"",
		"> 由 `scripts/capture-pi-web-ui-migration-baseline.js` 自动生成。仅记录 hash 和版本，不含密钥或插件配置内容。",
		"",
		"## 运行版本",
		"",
		"- pi：`" + (snapshot.versions.pi ?? "未知") + "`",
		"- pi-web-ui：`" + (snapshot.versions.piWebUi ?? "未知") + "`",
		"- 活跃 profile：`" + (snapshot.profile.path ?? "未找到") + "`",
		`- 活跃补丁数：${snapshot.profile.activePatches.length}`,
		"",
		"## 部署入口一致性",
		"",
		"| 插件 | 入口一致 | 不一致入口 |",
		"| --- | --- | --- |",
	];
	for (const [id, plugin] of Object.entries(snapshot.plugins)) {
		const entries = Object.entries(plugin.entries);
		const bad = entries.filter(([, value]) => !value.matches).map(([name]) => `\`${name}\``);
		lines.push(`| \`${id}\` | ${bad.length === 0 ? "是" : "否"} | ${bad.join("、") || "—"} |`);
	}
	lines.push("", "## 活跃补丁（文件 hash）", "");
	for (const patch of snapshot.profile.activePatches) lines.push(`- \`${patch.path}\`：\`${patch.sha256 ?? "缺失"}\``);
	lines.push("", "## 上游 clone 语义差异", "");
	if (snapshot.upstreamClone.semanticDiff.length) {
		for (const file of snapshot.upstreamClone.semanticDiff) lines.push(`- \`${file}\``);
	} else lines.push("- 无");
	lines.push("", "## 说明", "", "- 本基线用于迁移前后比对，不代表功能测试已通过。", "- 每次切换插件或升级 pi-web-ui 后重新采集；hash 改变必须有对应版本、变更说明和测试记录。", "");
	return lines.join("\n");
}

function main() {
	const webRoot = findWebUiRoot();
	if (!webRoot) throw new Error("找不到 pi-web-ui 安装目录");
	const piWebUiVersion = json(path.join(webRoot, "package.json"))?.version ?? null;
	const piVersion = packageVersion("@earendil-works/pi-coding-agent", webRoot);
	const profileRel = piWebUiVersion && piVersion ? path.join("configs", "pi-web-ui-profiles", `pi-${piVersion}_web-${piWebUiVersion}.json`) : null;
	const profile = profileRel ? json(path.join(ROOT, profileRel)) : null;
	if (!profile) throw new Error(`找不到当前版本 profile：${profileRel ?? "版本识别失败"}`);

	const sourceRoot = path.join(ROOT, "projects");
	const installedRoot = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi-web", "plugins");
	const plugins = {};
	// 所有 *-plugin 源目录都纳入基线，新增插件不必同步修改本脚本。
	for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.endsWith("-plugin")) continue;
		const sourceDir = path.join(sourceRoot, entry.name);
		const manifest = json(path.join(sourceDir, "manifest.json"));
		const id = typeof manifest?.id === "string" ? manifest.id.trim() : "";
		if (!id) continue;
		plugins[id] = {
			source: `projects/${entry.name}`,
			installed: `<dataDir>/plugins/${id}`,
			entries: pluginEntrypoints(sourceDir, path.join(installedRoot, id)),
		};
	}

	const wechatSource = path.join(ROOT, "projects", "pi-web-ui-source", "plugins", "wechat-ilink");
	// 本地受管 fork（同 id）优先作为部署真源；只有不存在时才直接以 upstream clone 为真源。
	if (!plugins["wechat-ilink"]) {
		plugins["wechat-ilink"] = {
			source: "projects/pi-web-ui-source/plugins/wechat-ilink",
			installed: "<dataDir>/plugins/wechat-ilink",
			entries: pluginEntrypoints(wechatSource, path.join(installedRoot, "wechat-ilink")),
		};
	}

	const clone = path.join(ROOT, "projects", "pi-web-ui-source");
	const diff = fs.existsSync(path.join(clone, ".git"))
		? run("git", ["-C", clone, "diff", "--ignore-space-at-eol", "--name-only"])
		: { code: 1, stdout: "" };
	const assets = path.join(webRoot, "web", "dist", "assets");
	const entry = fs.existsSync(assets)
		? fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name))
		: null;
	const pagePicker = path.join(ROOT, "projects", "page-picker-extension", "extension");

	const snapshot = {
		format: 1,
		capturedAt: new Date().toISOString(),
		versions: { pi: piVersion, piWebUi: piWebUiVersion },
		profile: {
			path: profileRel?.replaceAll("\\", "/") ?? null,
			activePatches: profile.patches.map((patch) => ({
				path: patch,
				sha256: sha256(path.join(ROOT, patch)),
			})),
		},
		runtimeArtifacts: {
			entryBundle: entry ? fileInfo(path.join(assets, entry)) : { exists: false, sha256: null, bytes: 0 },
			serviceWorker: fileInfo(path.join(webRoot, "web", "dist", "sw.js")),
			indexHtml: fileInfo(path.join(webRoot, "web", "dist", "index.html")),
		},
		plugins,
		browserExtension: {
			id: "page-picker",
			manifest: fileInfo(path.join(pagePicker, "manifest.json")),
			backgroundBundle: fileInfo(path.join(pagePicker, "dist", "background.js")),
		},
		upstreamClone: {
			semanticDiff: diff.code === 0 && diff.stdout ? diff.stdout.split(/\r?\n/).filter(Boolean) : [],
		},
	};

	fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
	fs.mkdirSync(path.dirname(REPORT), { recursive: true });
	fs.writeFileSync(OUTPUT, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
	fs.writeFileSync(REPORT, markdown(snapshot), "utf8");
	console.log(`✓ 已写入 ${path.relative(ROOT, OUTPUT)}`);
	console.log(`✓ 已写入 ${path.relative(ROOT, REPORT)}`);
	console.log(`  活跃补丁：${snapshot.profile.activePatches.length} 项；插件入口不一致：${Object.values(plugins).filter((plugin) => Object.values(plugin.entries).some((entry) => !entry.matches)).length} 个`);
}

try {
	main();
} catch (error) {
	console.error(`✗ 基线采集失败：${error.message}`);
	process.exit(1);
}
