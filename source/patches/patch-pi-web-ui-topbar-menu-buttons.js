#!/usr/bin/env node
/**
 * 将“更多”菜单中的运行位置、声音、语言、主题、版本和 GitHub 恢复为顶部独立按钮。
 *
 * pi-web-ui 0.92.0 已为这些原生功能实现完整的 topbar.primary 组件，但在默认 UI
 * 注册表中把它们标记为 hidden，因而统一落入“…”菜单。本补丁只取消这六项的默认
 * hidden 标记，继续复用宿主原生组件、交互、响应式溢出和样式，不修改第三方插件。
 *
 * 幂等；精确匹配 0.92.x 压缩 bundle；源码变化时退出码 2，不做模糊替换。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "topbar-menu-buttons-patch";

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
	console.log("✓ 原生菜单项顶栏按钮补丁已存在");
	process.exit(0);
}

const needle =
	"{id:`host:browser`,slot:`topbar.primary`,labelKey:`browserControl`,icon:`browser`,kind:`action`,order:41,group:`tools`,align:`end`,hidden:!0},{id:`host:tasks`" +
	",slot:`topbar.primary`,labelKey:`bgTasks`,icon:`layers`,kind:`action`,order:42,group:`tools`,align:`end`},{id:`host:settings`,slot:`topbar.primary`,labelKey:`settingsTitle`,icon:`settings`,kind:`action`,order:60,group:`system`,align:`end`},{id:`host:sound`,slot:`topbar.primary`,labelKey:`sound`,icon:`sound`,kind:`action`,order:70,group:`system`,hidden:!0,align:`end`},{id:`host:language`,slot:`topbar.primary`,labelKey:`language`,icon:`globe`,kind:`action`,order:80,group:`system`,hidden:!0,align:`end`},{id:`host:theme`,slot:`topbar.primary`,labelKey:`theme`,icon:`sun`,kind:`action`,order:82,group:`system`,hidden:!0,align:`end`},{id:`host:update`,slot:`topbar.primary`,labelKey:`update`,icon:`download`,kind:`action`,order:90,group:`system`,align:`end`,hidden:!0},{id:`host:github`,slot:`topbar.primary`,labelKey:`githubRepo`,icon:`github`,kind:`action`,order:200,group:`system`,align:`end`,hidden:!0}";

const replacement =
	"{id:`host:browser`,slot:`topbar.primary`,labelKey:`browserControl`,icon:`browser`,kind:`action`,order:41,group:`tools`,align:`end`},{id:`host:tasks`" +
	",slot:`topbar.primary`,labelKey:`bgTasks`,icon:`layers`,kind:`action`,order:42,group:`tools`,align:`end`},{id:`host:settings`,slot:`topbar.primary`,labelKey:`settingsTitle`,icon:`settings`,kind:`action`,order:60,group:`system`,align:`end`},{id:`host:sound`,slot:`topbar.primary`,labelKey:`sound`,icon:`sound`,kind:`action`,order:70,group:`system`,align:`end`},{id:`host:language`,slot:`topbar.primary`,labelKey:`language`,icon:`globe`,kind:`action`,order:80,group:`system`,align:`end`},{id:`host:theme`,slot:`topbar.primary`,labelKey:`theme`,icon:`sun`,kind:`action`,order:82,group:`system`,align:`end`},{id:`host:update`,slot:`topbar.primary`,labelKey:`update`,icon:`download`,kind:`action`,order:90,group:`system`,align:`end`},{id:`host:github`,slot:`topbar.primary`,labelKey:`githubRepo`,icon:`github`,kind:`action`,order:200,group:`system`,align:`end`}/*" + marker + "*/";

// 固定项集合的变量名会被压缩重命名（0.92.0 是 `$n`，0.94.1 是 `fr`），
// 所以这里只认结构不认名字：<var>=new Set([`host:settings`]);
const pinnedRe = /([A-Za-z_$][\w$]*)=new Set\(\[`host:settings`\]\);/g;
const pinnedHits = [...source.matchAll(pinnedRe)];
const count = source.split(needle).length - 1;
if (count !== 1 || pinnedHits.length !== 1) {
	console.error(
		`✗ pi-web-ui 目标代码已变化，未应用原生菜单项顶栏按钮补丁（注册表命中 ${count} 次，固定项命中 ${pinnedHits.length} 次）`,
	);
	process.exit(2);
}

source = source
	.replace(needle, replacement)
	.replace(pinnedRe, "$1=new Set([`host:settings`,`host:browser`,`host:sound`,`host:language`,`host:theme`,`host:update`,`host:github`]);");
fs.writeFileSync(target, source, "utf8");
console.log("✓ 已将运行位置、声音、语言、主题、版本和 GitHub 恢复为顶部独立按钮");
console.log(`  目标：${target}`);
