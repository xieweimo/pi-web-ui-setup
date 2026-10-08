/**
 * 插件市场条目回归测试：确保发布后可由官方「设置 → 界面插件 → 插件市场」识别并安装。
 *
 * 两个仓库布局都要能过：
 *   - 私有源码仓库：<root>/configs/codex-usage-plugin-market-entry.json
 *   - 对外贡献仓库：<root>/catalog.json（plugins/<id> 结构）
 * 运行：node <插件目录>/tests/market-entry.test.mjs
 *       （私有源码仓库：projects/codex-usage-plugin；对外贡献仓库：plugins/codex-usage）
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const CANDIDATES = [
	resolve(here, "../../../configs/codex-usage-plugin-market-entry.json"), // 私有源码仓库
	resolve(here, "../../../catalog.json"), // 对外贡献仓库（plugins/<id> 结构）
];

const manifestPath = resolve(here, "../manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const catalogPath = CANDIDATES.find((p) => existsSync(p));
assert.ok(catalogPath, `找不到插件市场条目，已尝试：\n${CANDIDATES.join("\n")}`);

const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
const entries = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : [];
const entry = entries.find((row) => row.id === manifest.id);
assert.ok(entry, `市场条目必须与插件 manifest.id（${manifest.id}）对应：${catalogPath}`);
assert.match(entry.source, /^[\w.-]+\/[\w.-]+\/.+/, "市场 source 必须是可由 pi-web-ui install 解析的 GitHub 子目录");
assert.match(entry.homepage, /^https:\/\/github\.com\//, "市场首页必须可公开访问");
assert.equal(entry.icon, manifest.icon);
console.log(`✓ 插件市场条目回归测试通过（${catalogPath}）`);
