#!/usr/bin/env node
/**
 * 快捷短语支持「排队」发送。
 *
 * pi-web-ui 的快捷短语点击后走内部发送函数 se(y)，只发 {type:"prompt",text,attachments}，
 * 没有 queue 参数 —— 所以它永远是「插队（立即发送）」。而输入框右侧的发送按钮才有
 * ⚡插队 / ⏳排队 两种语义（queue:true = AI 回答完全结束后再发）。
 *
 * 本补丁做两件事（都在压缩后的前端产物 web/dist/assets/index-*.js 里）：
 *   1. se 增加第二个参数 queue，并把它带进 Z({type:"prompt",...})；
 *   2. 每个快捷短语右侧多渲染一个 ⏳ 按钮 → se(y,true)，即排队发送。
 * 点击短语本身仍然是插队，行为与升级前一致。
 *
 * 幂等；由 pi-web-ui-launcher.ps1 在服务启动前执行；锚点不匹配时退出码 2 且不阻断服务。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "quick-chip-group";

/** 主入口 bundle：web/dist/assets/index-<hash>.js（只有一个）。 */
function bundlePath() {
	const dir = locateWebUiFile("web", "dist", "assets");
	if (!dir || !fs.existsSync(dir)) return null;
	const hit = fs.readdirSync(dir).find((name) => /^index-.*\.js$/.test(name));
	return hit ? path.join(dir, hit) : null;
}

const target = bundlePath();
if (!target) {
	console.error("✗ 找不到 pi-web-ui 的 web/dist/assets/index-*.js");
	process.exit(1);
}

/**
 * 一次性缓存清理：统一委托给 scripts/pi-web-ui-entry-cache-bust.js。
 *
 * 补丁曾经直接改 bundle 内容却保留 Vite 原文件名，Service Worker 又对 /assets 使用
 * cache-first，结果即使代码已撤回，浏览器仍可能长期拿到旧的 ⏳ 版本。
 * 现在这份逻辑（key 与当前 bundle 内容 hash 绑定、先删缓存再强制 cache:"reload" 回源、
 * 只重载一次）由入口缓存自愈模块统一维护，本补丁不再自行注入旧版挡块。
 */
function installOneTimeCacheCleanup() {
	try {
		const { refreshEntryCacheBust } = require("../scripts/pi-web-ui-entry-cache-bust.js");
		return refreshEntryCacheBust().changed;
	} catch {
		return false;
	}
}
/** 0.94.1 起上游已内建右键排队（chip 的 onContextMenu → send(e,true)），
 *  我们额外挂的 ⏳ 按钮不再需要 —— 带 --remove 运行即把它从 bundle 里撤掉（反向替换，幂等）。 */
const REMOVE = process.argv.includes("--remove");
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker) && !REMOVE) {
	console.log("✓ 快捷短语排队补丁已存在");
	process.exit(0);
}

/**
 * 不同 pi-web-ui 版本的压缩变量名会变化。每个版本保留一组精确锚点，
 * 只允许唯一命中，避免模糊替换误伤别处的 prompt 发送逻辑。
 */
const variants = [
	{
		name: "0.90.x",
		sendNeedle:
			"se=y=>{const ae=y.trim();if(ae){if(!Se){w(\"error\",J(\"netDisconnected\"));return}if(Z({type:\"prompt\",text:ae,attachments:Mt()})){ae&&Bl(ae),",
		sendReplacement:
			"se=(y,fq=false)=>{const ae=y.trim();if(ae){if(!Se){w(\"error\",J(\"netDisconnected\"));return}if(Z({type:\"prompt\",text:ae,queue:fq,attachments:Mt()})){ae&&Bl(ae),",
		chipNeedle:
			"children:F.map(y=>s.jsx(\"button\",{type:\"button\",className:\"quick-chip\",title:J(\"quickPhrasesTip\",{text:y}),disabled:!Se,onClick:()=>se(y),children:y},y))",
		chipReplacement:
			"children:F.map(y=>s.jsxs(\"span\",{className:\"" + marker + "\",style:{display:\"inline-flex\",alignItems:\"center\",gap:\"2px\"},children:[s.jsx(\"button\",{type:\"button\",className:\"quick-chip\",title:J(\"quickPhrasesTip\",{text:y}),disabled:!Se,onClick:()=>se(y),children:y},\"c\"),s.jsx(\"button\",{type:\"button\",className:\"quick-chip quick-chip-queue\",style:{padding:\"0 6px\",fontSize:\"11px\",opacity:.75},title:\"排队发送：AI 回答完全结束后再发，不打断当前回合\",disabled:!Se,onClick:()=>se(y,!0),children:\"⏳\"},\"q\")]},y))",
	},
	{
		// 0.94.x：上游 0.93.0 已内建排队发送（chip 的 onContextMenu → send(e,true)，
		// 文案 quickPhrasesSendTip）——所以这里不再需要改发送函数，只额外挂一个显眼的
		// ⏳ 按钮（鼠标用户不必去猜右键）。
		name: "0.94.x",
		chipNeedle:
			"children:y.map(e=>(0,X.jsx)(`button`,{type:`button`,className:`quick-chip`,title:`${F(`quickPhrasesTip`,{text:e})}（${F(`quickPhrasesSendTip`)}）`,disabled:!Xe,onClick:()=>nt(e),onContextMenu:t=>{t.preventDefault(),t.stopPropagation(),nt(e,!0)},children:e},e))",
		chipReplacement:
			"children:y.map(e=>(0,X.jsxs)(`span`,{className:`" + marker + "`,style:{display:`inline-flex`,alignItems:`center`,gap:`2px`},children:[(0,X.jsx)(`button`,{type:`button`,className:`quick-chip`,title:`${F(`quickPhrasesTip`,{text:e})}（${F(`quickPhrasesSendTip`)}）`,disabled:!Xe,onClick:()=>nt(e),onContextMenu:t=>{t.preventDefault(),t.stopPropagation(),nt(e,!0)},children:e},`c`),(0,X.jsx)(`button`,{type:`button`,className:`quick-chip quick-chip-queue`,style:{padding:`0 6px`,fontSize:`11px`,opacity:.75},title:`排队发送：AI 回答完全结束后再发，不打断当前回合`,disabled:!Xe,onClick:()=>nt(e,!0),children:`⏳`},`q`)]},e))",
	},
	{
		name: "0.92.x",
		sendNeedle:
			"tt=e=>{let t=e.trim();if(t){if(!Ye){m(`error`,F(`netDisconnected`));return}if($({type:`prompt`,text:t,attachments:$e()})){t&&Nd(t),",
		sendReplacement:
			"tt=(e,qq=false)=>{let t=e.trim();if(t){if(!Ye){m(`error`,F(`netDisconnected`));return}if($({type:`prompt`,text:t,queue:qq,attachments:$e()})){t&&Nd(t),",
		chipNeedle:
			"children:y.map(e=>(0,X.jsx)(`button`,{type:`button`,className:`quick-chip`,title:F(`quickPhrasesTip`,{text:e}),disabled:!Ye,onClick:()=>tt(e),children:e},e))",
		chipReplacement:
			"children:y.map(e=>(0,X.jsxs)(`span`,{className:`" + marker + "`,style:{display:`inline-flex`,alignItems:`center`,gap:`2px`},children:[(0,X.jsx)(`button`,{type:`button`,className:`quick-chip`,title:F(`quickPhrasesTip`,{text:e}),disabled:!Ye,onClick:()=>tt(e),children:e},`c`),(0,X.jsx)(`button`,{type:`button`,className:`quick-chip quick-chip-queue`,style:{padding:`0 6px`,fontSize:`11px`,opacity:.75},title:`排队发送：AI 回答完全结束后再发，不打断当前回合`,disabled:!Ye,onClick:()=>tt(e,!0),children:`⏳`},`q`)]},e))",
	},
];

// --remove：反向把已经加上的 ⏳ 换回上游原始 chip（幂等）
if (REMOVE) {
	const hit = variants.filter((v) => source.split(v.chipReplacement).length - 1 === 1);
	if (!hit.length) {
		console.log("✓ 未发现 ⏳ 按钮（无需移除）");
		if (installOneTimeCacheCleanup()) console.log("✓ 已安装一次性浏览器缓存清理（命中旧 bundle 时自动刷新）");
		process.exit(0);
	}
	let out = source.replace(hit[0].chipReplacement, hit[0].chipNeedle);
	if (hit[0].sendReplacement && out.includes(hit[0].sendReplacement)) out = out.replace(hit[0].sendReplacement, hit[0].sendNeedle);
	fs.writeFileSync(target, out, "utf8");
	installOneTimeCacheCleanup();
	console.log("✓ 已移除快捷短语右侧的 ⏳ 按钮（改用上游内建的右键排队）");
	console.log(`  目标：${target}`);
	process.exit(0);
}

const countOf = (needle) => source.split(needle).length - 1;
/** 有的版本上游已内建排队（无需改发送函数），此时 sendNeedle 省略。 */
const hitOnce = (needle) => !needle || countOf(needle) === 1;
const matched = variants.filter((v) => hitOnce(v.sendNeedle) && hitOnce(v.chipNeedle));
if (matched.length !== 1) {
	console.error(
		`✗ pi-web-ui 版本的目标代码已变化，未应用快捷短语排队补丁（匹配版本数 ${matched.length}）`,
	);
	process.exit(2);
}
const variant = matched[0];
if (variant.sendNeedle) source = source.replace(variant.sendNeedle, variant.sendReplacement);
source = source.replace(variant.chipNeedle, variant.chipReplacement);
fs.writeFileSync(target, source, "utf8");
console.log("✓ 已应用快捷短语排队补丁（短语右侧新增 ⏳ 按钮）");
console.log(`  目标：${target}`);
