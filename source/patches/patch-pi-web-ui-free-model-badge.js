#!/usr/bin/env node
/**
 * pi-web-ui：模型下拉给免费模型打「免费」徽标。
 *
 * 背景：模型可见性补丁（patches/patch-pi-web-ui-free-models-only.js）把按量计费
 * 模型从下拉里拿掉了，但列表里免费的（智谱免费款 / NVIDIA 免费档 /
 * OpenRouter `:free`）与「订阅内 / 白名单」的混在一起，看不出哪个真免费。
 * 用户要求：「免费的给我标出来」。
 *
 * 做法：服务端已在 models 下发数据里补了 `free` 布尔字段（cost 四项全 0），
 * 这里就地改前端 bundle 的徽标渲染，在既有的「推理 / 视觉」徽标前插入绿色「免费」徽标。
 *
 * 幂等：命中 marker 直接跳过；锚点变化退出码 2，不做模糊替换。
 * 注意：这是就地改 `web/dist/assets/index-<hash>.js`，改完必须让入口缓存失效
 * （跑 node scripts/pi-web-ui-entry-cache-bust.js，或由启动器/秒级校验自动对齐），
 * 否则浏览器会继续用强缓存里的旧 bundle，出现「补丁已落地但界面没变」。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "free-model-badge-v1";
const assets = locateWebUiFile("web", "dist", "assets");
if (!assets || !fs.existsSync(assets)) {
	console.error("✗ 找不到 pi-web-ui 的 web/dist/assets");
	process.exit(1);
}
const bundleName = fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name));
const target = bundleName ? path.join(assets, bundleName) : null;
if (!target || !fs.existsSync(target)) {
	console.error("✗ 找不到入口 bundle（index-*.js）");
	process.exit(1);
}

let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
	console.log(`✓ 免费徽标已落地（${marker}）`);
	process.exit(0);
}

// 模型行徽标容器的开头（bundle 里 `dd-model-badges` 只出现一次）。
// 0.114.x 的 JSX runtime 变量由 `X` 压缩为 `$`，并在条件里新增了 enabled 作用域徽标。
// 注意：括号必须用 \( \) 显式匹配（正则中未转义的括号是分组语法，不参与匹配），
// 否则替换串会多出一层括号，注入后 bundle 语法损坏。
const anchorRe =
	/\(t\.reasoning\|\|t\.vision\|\|D&&t\.enabled===!1\)&&\(0,(\$|X)\.jsxs\)\(`span`,\{className:`dd-model-badges`,children:\[/;
const matched = source.match(anchorRe);
if (!matched) {
	console.error(`✗ 徽标锚点未命中（0.114.x 结构已变化），拒绝模糊替换`);
	process.exit(2);
}
const runtime = matched[1];
const patched =
	`(t.reasoning||t.vision||t.free||D&&t.enabled===!1)&&(0,${runtime}.jsxs)(\`span\`,{className:\`dd-model-badges\`,children:[` +
	`/* ${marker} */` +
	`t.free&&(0,${runtime}.jsx)(\`span\`,{className:\`dd-model-badge\`,style:{background:\`rgba(34,197,94,.16)\`,color:\`#4ade80\`,borderColor:\`rgba(34,197,94,.45)\`},children:\`免费\`}),`;

source = source.replace(anchorRe, () => patched);
fs.writeFileSync(target, source);
console.log(`✓ 已为 ${path.basename(target)} 注入「免费」徽标（${marker}）`);
