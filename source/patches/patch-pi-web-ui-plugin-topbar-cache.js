#!/usr/bin/env node
/**
 * 让插件顶栏入口在刷新后的首帧稳定出现，不再等会话 attach + 插件重扫后才补进来。
 *
 * 只缓存 manifest 中绘制 topbar.primary 所需的非敏感字段；插件 bundle、菜单、工具与
 * 其它槽位仍只使用服务端权威清单。pluginsLoaded 明确区分“清单尚未下发”和“确实
 * 一个插件也没装”，所以服务端空清单也会立即清掉旧缓存入口。
 *
 * 幂等；精确匹配 pi-web-ui 0.95.0 压缩 bundle；源码变化时退出码 2，不做模糊替换。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "plugin-topbar-cache-patch-v2";
const oldMarker = "plugin-topbar-cache-patch";
const cacheKey = "pi-web-ui:plugin-topbar-cache:v1";

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
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
	console.log("✓ 插件顶栏首帧缓存补丁 v2 已存在");
	process.exit(0);
}

const initialNeedle = "plugins:[],pluginsEpoch:0,";
const initialReplacement = "plugins:[],pluginsLoaded:!1,pluginsEpoch:0,";
const reducerNeedle = "plugins:t.plugins,pluginsEpoch:t.epoch";
const reducerReplacement = "plugins:t.plugins,pluginsLoaded:!0,pluginsEpoch:t.epoch";
const pristineApp =
	"E=(0,m.useMemo)(()=>{let r=[],i=xi(ui(n.plugins),{locale:t,t:t=>e(t),disabledPlugins:n.settings?.disabledPlugins??[],layout:n.settings?.uiLayout,diagnostics:r});for(let e of r)console.warn(`[ui-slot] ${e.pluginId?`[${e.pluginId}] `:``}${e.message}`);return i},[n.plugins,n.settings?.disabledPlugins,n.settings?.uiLayout,t,e])";
// 0.99.0：ui-slots 的压缩 helper 名从 `xi(ui(...))` 变成 `ji(bi(...))`，调用形态一致。
const pristineApp0990 =
	"E=(0,m.useMemo)(()=>{let r=[],i=ji(bi(n.plugins),{locale:t,t:t=>e(t),disabledPlugins:n.settings?.disabledPlugins??[],layout:n.settings?.uiLayout,diagnostics:r});for(let e of r)console.warn(`[ui-slot] ${e.pluginId?`[${e.pluginId}] `:``}${e.message}`);return i},[n.plugins,n.settings?.disabledPlugins,n.settings?.uiLayout,t,e])";
const oldApp =
	"E=(0,f.useMemo)(()=>{let r=[],i=n.plugins;if(i.length)try{let e=i.map(e=>{let t=(e.ui?.items??[]).filter(e=>e.slot===`topbar.primary`);return{id:e.id,name:e.name,...e.icon?{icon:e.icon}:{},...e.iconSvg?{iconSvg:e.iconSvg}:{},...e.view===!1?{view:!1}:{},...t.length?{ui:{items:t}}:{}}}).filter(e=>e.view!==!1||e.ui?.items.length);localStorage.setItem(`" + cacheKey + "`,JSON.stringify(e))}catch{}else if(n.state===null)try{let e=JSON.parse(localStorage.getItem(`" + cacheKey + "`)??`[]`);Array.isArray(e)&&(i=e)}catch{}let a=Zr(Br(i),{locale:t,t:t=>e(t),disabledPlugins:n.settings?.disabledPlugins??[],layout:n.settings?.uiLayout,diagnostics:r});for(let e of r)console.warn(`[ui-slot] ${e.pluginId?`[${e.pluginId}] `:``}${e.message}`);return a/*" + oldMarker + "*/},[n.plugins,n.state,n.settings?.disabledPlugins,n.settings?.uiLayout,t,e])";
const appReplacement =
	"E=(0,m.useMemo)(()=>{let r=[],i=n.plugins;if(i.length)try{let e=i.map(e=>{let t=(e.ui?.items??[]).filter(e=>e.slot===`topbar.primary`);return{id:e.id,name:e.name,...e.icon?{icon:e.icon}:{},...e.iconSvg?{iconSvg:e.iconSvg}:{},...e.view===!1?{view:!1}:{},...t.length?{ui:{items:t}}:{}}}).filter(e=>e.view!==!1||e.ui?.items.length);localStorage.setItem(`" + cacheKey + "`,JSON.stringify(e))}catch{}else if(!n.pluginsLoaded)try{let e=JSON.parse(localStorage.getItem(`" + cacheKey + "`)??`[]`);Array.isArray(e)&&(i=e)}catch{}let a=xi(ui(i),{locale:t,t:t=>e(t),disabledPlugins:n.settings?.disabledPlugins??[],layout:n.settings?.uiLayout,diagnostics:r});for(let e of r)console.warn(`[ui-slot] ${e.pluginId?`[${e.pluginId}] `:``}${e.message}`);return a/*" + marker + "*/},[n.plugins,n.pluginsLoaded,n.settings?.disabledPlugins,n.settings?.uiLayout,t,e])";
// 0.99.0 同样只换 helper 名
const appReplacement0990 =
	"E=(0,m.useMemo)(()=>{let r=[],i=n.plugins;if(i.length)try{let e=i.map(e=>{let t=(e.ui?.items??[]).filter(e=>e.slot===`topbar.primary`);return{id:e.id,name:e.name,...e.icon?{icon:e.icon}:{},...e.iconSvg?{iconSvg:e.iconSvg}:{},...e.view===!1?{view:!1}:{},...t.length?{ui:{items:t}}:{}}}).filter(e=>e.view!==!1||e.ui?.items.length);localStorage.setItem(`" + cacheKey + "`,JSON.stringify(e))}catch{}else if(!n.pluginsLoaded)try{let e=JSON.parse(localStorage.getItem(`" + cacheKey + "`)??`[]`);Array.isArray(e)&&(i=e)}catch{}let a=ji(bi(i),{locale:t,t:t=>e(t),disabledPlugins:n.settings?.disabledPlugins??[],layout:n.settings?.uiLayout,diagnostics:r});for(let e of r)console.warn(`[ui-slot] ${e.pluginId?`[${e.pluginId}] `:``}${e.message}`);return a/*" + marker + "*/},[n.plugins,n.pluginsLoaded,n.settings?.disabledPlugins,n.settings?.uiLayout,t,e])";
// 变体表：按版本向后兼容，命中哪个用哪个；全部命不上就退出码 2（不做模糊替换）。
const appVariants = [
	{ version: "0.95.x", needle: oldApp, replacement: appReplacement },
	{ version: "0.96.x", needle: pristineApp, replacement: appReplacement },
	{ version: "0.98+/0.99.x", needle: pristineApp0990, replacement: appReplacement0990 },
];

const appVariant = appVariants.find((v) => source.includes(v.needle));
const counts = {
	initial: source.includes(initialReplacement) ? 0 : source.split(initialNeedle).length - 1,
	reducer: source.includes(reducerReplacement) ? 0 : source.split(reducerNeedle).length - 1,
	app: appVariant ? source.split(appVariant.needle).length - 1 : 0,
};
if (counts.initial > 1 || counts.reducer > 1 || counts.app !== 1 || (!source.includes(initialReplacement) && counts.initial !== 1) || (!source.includes(reducerReplacement) && counts.reducer !== 1)) {
	console.error(`✗ pi-web-ui 目标代码已变化，未应用插件顶栏首帧缓存补丁（initial ${counts.initial} / reducer ${counts.reducer} / app ${counts.app}；已知变体 ${appVariants.map((v) => v.version).join("/")}）`);
	process.exit(2);
}

if (!source.includes(initialReplacement)) source = source.replace(initialNeedle, initialReplacement);
if (!source.includes(reducerReplacement)) source = source.replace(reducerNeedle, reducerReplacement);
source = source.replace(appVariant.needle, appVariant.replacement);
fs.writeFileSync(target, source, "utf8");
console.log(`✓ 已启用插件顶栏首帧缓存 v2（服务端权威清单仍负责实际插件加载；匹配变体 ${appVariant.version}）`);
console.log(`  目标：${target}`);
