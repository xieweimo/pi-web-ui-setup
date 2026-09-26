#!/usr/bin/env node
/**
 * 让 Service Worker 对**入口 bundle** 强制回源重校验（piwork-sw-entry-revalidate-v1）。
 *
 * 为什么需要：前端补丁都是就地改 `web/dist/assets/index-<hash>.js`（文件名不变），
 * 而 sw.js 对 /assets 是 cache-first + 服务器给 `immutable, max-age=1y`。于是浏览器
 * 会长期跑补丁前的老代码——「说改好了，用起来还是老样子」的根因之一。
 *
 * 这里只对入口 chunk 破例：`fetch(request, {cache:"no-cache"})` 走条件请求，
 * 内容没变时是 304（几乎零成本），内容变了立刻拿到新版本；其余 /assets 资源
 * （字体、图片、其它 chunk）保持原有 cache-first，不受影响。
 *
 * 配合 scripts/pi-web-ui-entry-cache-bust.js（index.html 里的一次性自愈脚本）
 * 双保险：一个管「HTML 能拿到就能换」，一个管「SW 缓存里也不留旧的」。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "piwork-sw-entry-revalidate-v1";
const swFile = locateWebUiFile("web", "dist", "sw.js");
if (!swFile || !fs.existsSync(swFile)) {
	console.error("✗ 找不到 pi-web-ui 的 web/dist/sw.js");
	process.exit(1);
}
let source = fs.readFileSync(swFile, "utf8");
if (source.includes(marker)) {
	console.log("✓ 入口 bundle 强制重校验补丁已存在");
	process.exit(0);
}

// 锚点：静态资源分支的入口（0.95.0 实测唯一命中）。只允许精确唯一命中，
// 避免在别处插错位置。
const needle = `\tif (isStatic) {\n\t\tevent.respondWith(\n\t\t\tcaches.match(request).then((cached) => {\n\t\t\t\tif (cached) return cached;`;
const replacement = `\tif (isStatic) {\n\t\t// ${marker}：入口 bundle 是就地打补丁的（文件名不变），必须每次回源重校验；\n\t\t// 其余 hashed 资源仍走 cache-first。304 时浏览器直接用本地副本，代价只有一次条件请求。\n\t\tif (/^\\/assets\\/index-[^/]+\\.js$/.test(path)) {\n\t\t\tevent.respondWith(\n\t\t\t\tfetch(request, { cache: "no-cache" }).catch(() =>\n\t\t\t\t\tcaches.match(request).then((cached) => cached || Response.error()),\n\t\t\t\t),\n\t\t\t);\n\t\t\treturn;\n\t\t}\n\t\tevent.respondWith(\n\t\t\tcaches.match(request).then((cached) => {\n\t\t\t\tif (cached) return cached;`;

const count = source.split(needle).length - 1;
if (count !== 1) {
	console.error(`✗ sw.js 入口缓存分支锚点命中 ${count} 次，拒绝模糊替换`);
	process.exit(2);
}
fs.writeFileSync(swFile, source.replace(needle, replacement), "utf8");
console.log("✓ 已让 Service Worker 对入口 bundle 强制回源重校验");
