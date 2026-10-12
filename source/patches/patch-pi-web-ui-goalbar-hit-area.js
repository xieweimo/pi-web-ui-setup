#!/usr/bin/env node
/**
 * 修复 0.104.4 消息区负 margin 覆盖目标输入框的点击区域。
 * 将目标栏提升到消息区之上，不改变滚动容器尺寸；升级后锚点不符则拒绝注入。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "piwork-goalbar-hit-area-v1";
const assets = locateWebUiFile("web", "dist", "assets");
const bundle = assets && fs.existsSync(assets)
	? fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name))
	: null;
if (!bundle) {
	console.error("✗ 找不到 pi-web-ui 前端入口 bundle");
	process.exit(1);
}
const target = path.join(assets, bundle);
const source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
	console.log(`✓ 目标栏点击区域补丁已落地（${marker}）`);
	process.exit(0);
}
const anchors = ["className:`goalbar-input`", "className:`goalbar-slot`", "--composer-strip", "margin-bottom:calc(-1 * var(--composer-strip))"];
// 前两项在 JS bundle，后两项在 CSS bundle；只有已确认的遮挡布局才允许注入。
const cssFile = fs.readdirSync(assets).find((name) => /^index-.*\.css$/.test(name));
const css = cssFile ? fs.readFileSync(path.join(assets, cssFile), "utf8") : "";
if (anchors.slice(0, 2).some((anchor) => !source.includes(anchor)) || anchors.slice(2).some((anchor) => !css.includes(anchor))) {
	console.error("✗ 目标栏或消息区布局锚点已变化，拒绝注入");
	process.exit(2);
}
const injection = `;(()=>{if(!document.getElementById("${marker}")){const s=document.createElement("style");s.id="${marker}";s.textContent=".main > .goalbar-slot{position:relative;z-index:1}";document.head.appendChild(s)}})();`;
fs.writeFileSync(target, source + injection);
console.log(`✓ 已修复 ${bundle} 的目标栏点击区域（${marker}）`);
