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

/**
 * dev 源码目标：vite(5173) 现场编译 source checkout，不读 web/dist，所以只打 bundle
 * 对它完全无效。改 `REQUIRED_TOPBAR_ITEM_IDS` 即可 —— 该循环排在用户布局偏好之后、
 * 分组排序之前，会把命中条目强制 `slot=topbar.primary` + `hidden=false`，足以覆盖
 * 注册表里那 6 处 `hidden: true` 缺省，不必去动上游条目定义与注释。
 * 失败直接退出码 2，绝不静默跳过（否则又变成“生产有、5173 没有”）。
 */
function patchDevSource() {
	const src = path.join(path.resolve(__dirname, ".."), "projects", "pi-web-ui-source", "web", "src", "ui-slots.ts");
	if (!fs.existsSync(src)) {
		console.log("· 未找到 source checkout，跳过 dev 源码补丁");
		return;
	}
	const raw = fs.readFileSync(src, "utf8");
	if (raw.includes(marker)) {
		console.log("✓ 原生菜单项顶栏按钮补丁已存在（dev 源码 ui-slots.ts）");
		return;
	}
	const needle = `export const REQUIRED_TOPBAR_ITEM_IDS: ReadonlySet<string> = new Set(["host:settings"]);`;
	const replacement = `export const REQUIRED_TOPBAR_ITEM_IDS: ReadonlySet<string> = new Set([
	"host:settings",
	// ${marker}：上游缺省 hidden:true 把这六项收进「⋯」菜单，本项目要求它们直接显示在顶栏
	//（与生产 bundle 补丁同语义）。
	"host:browser",
	"host:sound",
	"host:language",
	"host:theme",
	"host:update",
	"host:github",
]);`;
	// 源码是 CRLF（上游仓库检出）：按 LF 匹配，写回时还原原行尾。
	const crlf = raw.includes("\r\n");
	const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
	const hits = text.split(needle).length - 1;
	if (hits !== 1) {
		console.error(`✗ dev 源码固定项锚点命中 ${hits} 次，拒绝模糊替换（上游可能改了该常量）`);
		process.exit(2);
	}
	const patched = text.replace(needle, replacement);
	fs.writeFileSync(src, crlf ? patched.replace(/\n/g, "\r\n") : patched, "utf8");
	console.log("✓ 已把六项加进顶栏常驻集合（dev 源码 ui-slots.ts，vite 热更新即时生效）");
}

patchDevSource();

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
const pinnedRe = /([A-Za-z_$][\w$]*)=new Set\(\[`host:settings`([^\]]*)\]\)/g;
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
	// 用函数形式：`$2` 是上游原本就有的项（0.96.1 是 `,`host:history`,`host:files``），必须原样保留；
	// 末尾**不加** `;` —— 0.96.1 里它是 `ti=...(...),ni=...` 逗号分隔声明，多一个分号就是语法错误。
	.replace(pinnedRe, (_m, varName, rest) => `${varName}=new Set([\`host:settings\`${rest},\`host:browser\`,\`host:sound\`,\`host:language\`,\`host:theme\`,\`host:update\`,\`host:github\`])`);
fs.writeFileSync(target, source, "utf8");
console.log("✓ 已将运行位置、声音、语言、主题、版本和 GitHub 恢复为顶部独立按钮");
console.log(`  目标：${target}`);
