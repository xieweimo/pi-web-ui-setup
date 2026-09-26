#!/usr/bin/env node
/**
 * 入口 bundle 的浏览器缓存失效（piwork-entry-cache-bust-v1）。
 *
 * 背景：所有前端补丁都是**就地改** `web/dist/assets/index-<hash>.js`，文件名不变；
 * 而 pi-web-ui 对 /assets 发的是 `Cache-Control: immutable, max-age=31536000`，
 * Service Worker（sw.js）对 /assets 又是 cache-first。结果：补丁打上了，浏览器却
 * 一直用旧代码 —— 用户看到的现象就是「说改好了，但用起来还是老样子」。
 * （2026-09-25 实测：清空任务看板的补丁早已落地，浏览器里还在弹旧版的 confirm 框。）
 *
 * 做法：在 index.html 里前置一段「每个 bundle 内容版本只跑一次」的自愈脚本：
 *   1. 把该 URL 从所有 Cache Storage 里删掉（SW 的 cache-first 随即落空）；
 *   2. `fetch(url, {cache:"reload"})` 强制回源，绕开 immutable 的 HTTP 缓存，
 *      同时 SW 会把新版本写回自己的缓存；
 *   3. reload 一次，页面即运行新代码（localStorage 标记保证只重载一次，不会循环）。
 *
 * key 与文件名都与 bundle 的**内容 hash**绑定：内容一变 key 就变，自愈脚本必然再跑一次；
 * 内容没变（补丁幂等重放）则完全不动。
 *
 * 用法：
 *   node scripts/pi-web-ui-entry-cache-bust.js            # 刷新（需要时才算写）
 *   node scripts/pi-web-ui-entry-cache-bust.js --check    # 只校验，不写；不一致退出码 1
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { locateWebUiFile } = require("./pi-web-ui-locate.js");

const MARKER = "piwork-entry-cache-bust-v1";
const BEGIN = "<!-- piwork-entry-cache-bust:start -->";
const END = "<!-- piwork-entry-cache-bust:end -->";
/** 早期由 quick-phrase-queue 补丁注入的同类挡块，统一由本脚本接管。 */
const LEGACY_BLOCKS = [
	["<!-- piwork-quick-queue-cache-clean:start -->", "<!-- piwork-quick-queue-cache-clean:end -->"],
];

function entryBundle() {
	const dir = locateWebUiFile("web", "dist", "assets");
	if (!dir || !fs.existsSync(dir)) return null;
	const hit = fs.readdirSync(dir).find((name) => /^index-.*\.js$/.test(name));
	return hit ? path.join(dir, hit) : null;
}

function escapeRe(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 期望写进 index.html 的挡块（key/URL 都按当前 bundle 内容 hash 生成）。 */
function buildBlock(bundlePath) {
	const content = fs.readFileSync(bundlePath);
	const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
	const assetUrl = `/assets/${path.basename(bundlePath)}`;
	const script =
		`<script>(()=>{/*${MARKER}*/` +
		`const k="piwork:entry-cache-bust:${hash}",` +
		`u=new URL(${JSON.stringify(assetUrl)},location.origin).href;` +
		`if(localStorage.getItem(k)==="1")return;` +
		`(async()=>{try{if("caches"in window){const ns=await caches.keys();` +
		`await Promise.all(ns.map(async n=>(await caches.open(n)).delete(u)))}` +
		`await fetch(u,{cache:"reload"})}catch(e){}` +
		`localStorage.setItem(k,"1");location.reload()})()})()</script>`;
	return `${BEGIN}\n\t${script}\n\t${END}`;
}

/**
 * 让 index.html 的缓存自愈挡块与当前 bundle 对齐。
 * @returns {{changed: boolean, hash: string, reason?: string}}
 */
function refreshEntryCacheBust(dryRun = false) {
	const bundle = entryBundle();
	if (!bundle) throw new Error("找不到 pi-web-ui 的 web/dist/assets/index-*.js");
	const distDir = path.dirname(path.dirname(bundle));
	const indexFile = path.join(distDir, "index.html");
	if (!fs.existsSync(indexFile)) throw new Error(`找不到 ${indexFile}`);

	const hash = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex").slice(0, 12);
	const block = buildBlock(bundle);
	let html = fs.readFileSync(indexFile, "utf8");
	const original = html;

	for (const [b, e] of LEGACY_BLOCKS) {
		html = html.replace(new RegExp(`${escapeRe(b)}[\\s\\S]*?${escapeRe(e)}`), "");
	}
	const current = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
	if (current.test(html)) {
		html = html.replace(current, block);
	} else {
		// 一律前置到主模块 script 之前：重载发生得越早，越不会白跑一遍旧代码。
		const anchor = /(?=\s*<!-- piwork-quick-queue-cache-clean:start -->|\s*<script type="module")/;
		if (anchor.test(html)) html = html.replace(anchor, `\n\t${block}`);
		else html = html.replace(/(?=<\/head>)/, `\t${block}\n`);
	}
	const changed = html !== original;
	if (changed && !dryRun) fs.writeFileSync(indexFile, html, "utf8");
	return { changed, hash, indexFile };
}

if (require.main === module) {
	const CHECK_ONLY = process.argv.includes("--check");
	try {
		const r = refreshEntryCacheBust(CHECK_ONLY);
		if (CHECK_ONLY && r.changed) {
			console.error(`✗ 入口 bundle 缓存自愈未对齐（当前 bundle hash ${r.hash}，需要跑一次 scripts/pi-web-ui-entry-cache-bust.js）`);
			process.exit(1);
		}
		if (CHECK_ONLY) {
			console.log(`✓ 入口 bundle 缓存自愈已对齐（${r.hash}）`);
			process.exit(0);
		}
		console.log(r.changed ? `✓ 已刷新入口 bundle 缓存自愈标记（hash ${r.hash}）` : `✓ 入口 bundle 缓存自愈已是最新（hash ${r.hash}）`);
	} catch (error) {
		console.error(`✗ ${error.message}`);
		process.exit(2);
	}
}

module.exports = { refreshEntryCacheBust, entryBundle };
