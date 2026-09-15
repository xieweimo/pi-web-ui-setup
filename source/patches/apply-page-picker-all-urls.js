#!/usr/bin/env node
/**
 * page-picker 浏览器扩展：放行「所有网站」（AI 可操作任意 http/https 页面）。
 *
 * 官方扩展默认要你逐个站点人工授权，一共四道关卡，本补丁全部打开：
 *   1) manifest.json 的 host_permissions 只含 localhost / 127.0.0.1，其余站点是
 *      optional_host_permissions —— 没有 host 权限时 chrome.scripting 注入不进去；
 *   2) roleOf() 只给三种页面注入页面桥：pi-web-ui 页（host）、aiPages 里授权的页（target）、
 *      配对过的页（peer）；其余一律 "none" → 不注入；
 *   3) aiPages 为空时 decideAiRoute() 直接拒绝模型的动作；
 *   4) browser_page 的 pages 列表 = pi-web-ui 页面上桥的 peers = aiPages 的 origin 列表
 *      （见 armBridge：role === "host" ? context.aiPages.map(...) : peersOf(pairs, origin)），
 *      所以没授权的页面连"被发现"都做不到。
 *
 * 结果：模型能看到当前打开的所有 http/https 页面并直接操作它们。
 *
 * 安全提醒：这等于把你打开的**任何**网站（邮箱、网盘、后台系统）都交给 AI 页面工具，
 * 只在完全信任这台机器/这个模型时使用。想恢复官方行为：清空 extension/ 后重新解压
 * page-picker.zip，再去 edge://extensions 点「重新加载」。
 *
 * 幂等（四个片段各自检查标记）；改完要在 edge://extensions 点「重新加载」，
 * Edge 会要求确认新增的全站访问权限。
 *
 * 用法：node patches/apply-page-picker-all-urls.js [--dir <扩展目录>]
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dirFlag = process.argv.indexOf("--dir");
const extDir =
	dirFlag >= 0 ? path.resolve(process.argv[dirFlag + 1]) : path.join(root, "projects", "page-picker-extension", "extension");
const MARK = "page-picker-all-urls";
const ALL_URLS = ["http://*/*", "https://*/*"];

const manifestFile = path.join(extDir, "manifest.json");
const bgFile = path.join(extDir, "dist", "background.js");

if (!fs.existsSync(manifestFile) || !fs.existsSync(bgFile)) {
	console.error(`✗ 找不到扩展文件：${manifestFile} / ${bgFile}`);
	console.error("  先在 projects/page-picker-extension/ 里解压官方 page-picker-extension.zip。");
	process.exit(1);
}

/** 每个片段：{ tag, needle, replacement }，needle 必须唯一。 */
const EDITS = [
	{
		tag: "decide",
		needle: `  if (aiPages.length === 0) {`,
		replacement:
			`  /* ${MARK}(decide): 模型指定了 target 就放行，不再要求该 origin 在 aiPages 里。 */\n` +
			`  if (want) return { ok: true, page: { origin: want, title: want }, peer: want };\n` +
			`  if (aiPages.length === 0) {`,
	},
	{
		tag: "role",
		needle: `  if (peersOf(ctx.pairs, origin).length > 0) return "peer";\n  return "none";\n}`,
		replacement:
			`  if (peersOf(ctx.pairs, origin).length > 0) return "peer";\n` +
			`  /* ${MARK}(role): 其余 http/https 页面也当作「已授权给 AI 的页面」，以便注入页面桥。 */\n` +
			`  return "target";\n}`,
	},
	{
		tag: "peers",
		needle: `  const peers = role === "host" ? context.aiPages.map((page) => page.origin) : peersOf(context.pairs, origin);`,
		replacement:
			`  let peers = role === "host" ? context.aiPages.map((page) => page.origin) : peersOf(context.pairs, origin);\n` +
			`  if (role === "host") {\n` +
			`    /* ${MARK}(peers): 把当前打开的所有 http/https 页面一并列给模型（pages 动作的返回值）。 */\n` +
			`    try {\n` +
			`      const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });\n` +
			`      const selfOrigin = normalizeOrigin(context.settings.serverUrl);\n` +
			`      const open = tabs.map((t) => (t.url ? normalizeOrigin(t.url) : "")).filter((o) => o && o !== selfOrigin);\n` +
			`      peers = [...new Set([...peers, ...open])];\n` +
			`    } catch {\n` +
			`    }\n` +
			`  }`,
	},
	{
		tag: "pages",
		needle:
			`  if (op === "pages") {\n` +
			`    const open = await openOrigins(ctx.aiPages.map((page) => page.origin));\n` +
			`    return {\n` +
			`      ok: true,\n` +
			`      value: {\n` +
			`        pages: ctx.aiPages.map((page) => ({\n` +
			`          origin: page.origin,\n` +
			`          title: page.title ?? page.origin,\n` +
			`          open: open.has(page.origin)\n` +
			`        }))\n` +
			`      }\n` +
			`    };\n` +
			`  }`,
		replacement:
			`  if (op === "pages") {\n` +
			`    /* ${MARK}(pages): 除授权表外，把当前打开的所有 http/https 页面也列出来（排除 pi-web-ui 自己）。 */\n` +
			`    const selfOrigin = normalizeOrigin(ctx.settings.serverUrl);\n` +
			`    let allTabs = [];\n` +
			`    try {\n` +
			`      allTabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });\n` +
			`    } catch {\n` +
			`      allTabs = [];\n` +
			`    }\n` +
			`    const extraPages = [];\n` +
			`    for (const t of allTabs) {\n` +
			`      const o = t.url ? normalizeOrigin(t.url) : "";\n` +
			`      if (!o || o === selfOrigin) continue;\n` +
			`      if (!extraPages.some((p) => p.origin === o)) extraPages.push({ origin: o, title: t.title || o });\n` +
			`    }\n` +
			`    const pageList = [...ctx.aiPages.map((page) => ({ origin: page.origin, title: page.title ?? page.origin })), ...extraPages];\n` +
			`    const open = await openOrigins(pageList.map((p) => p.origin));\n` +
			`    return {\n` +
			`      ok: true,\n` +
			`      value: {\n` +
			`        pages: pageList.map((p) => ({ origin: p.origin, title: p.title, open: open.has(p.origin) }))\n` +
			`      }\n` +
			`    };\n` +
			`  }`,
	},
];

// ---- 1. manifest：host_permissions 扩到全站 ----
let manifest;
try {
	manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
} catch (err) {
	console.error(`✗ manifest.json 解析失败：${err.message}`);
	process.exit(1);
}
const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
if (hosts.includes("http://*/*") && hosts.includes("https://*/*")) {
	console.log("✓ manifest 已是全站权限，跳过");
} else {
	manifest.host_permissions = ALL_URLS;
	fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, "\t") + "\n", "utf8");
	console.log(`✓ manifest.host_permissions → ${ALL_URLS.join(", ")}`);
}

// ---- 2. background.js：三处逻辑放行 ----
let bg = fs.readFileSync(bgFile, "utf8");
let changed = 0;
for (const edit of EDITS) {
	if (bg.includes(`${MARK}(${edit.tag})`)) {
		console.log(`✓ background.js 已含 ${edit.tag} 片段，跳过`);
		continue;
	}
	const count = bg.split(edit.needle).length - 1;
	if (count !== 1) {
		console.error(`✗ ${edit.tag} 的锚点出现 ${count} 次（应为 1 次），扩展版本可能已变化，跳过这一段`);
		process.exitCode = 2;
		continue;
	}
	bg = bg.replace(edit.needle, edit.replacement);
	changed += 1;
	console.log(`✓ background.js 已插入 ${edit.tag} 片段`);
}
if (changed > 0) fs.writeFileSync(bgFile, bg, "utf8");

console.log("\n下一步：到 edge://extensions 点该扩展的「重新加载」（确认新增的全站访问权限），");
console.log("然后刷新各个目标页面 —— 页面桥只在页面加载时注入，已打开的页面必须刷新一次。");
