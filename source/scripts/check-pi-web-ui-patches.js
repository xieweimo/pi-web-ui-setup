#!/usr/bin/env node
/**
 * pi-web-ui 补丁「秒级」校验（替代不了真实页面自检，但能把 90% 的失败提前拦下）
 *
 * 只做三件事，都不需要重启服务、不需要浏览器：
 *   1. 版本对齐：pi-web-ui 版本 + pi 版本 → 必须存在同名 profile；
 *   2. 补丁落地：按 profile 逐项检查「标记字符串是否已在目标文件里」；
 *      缺失时**才**实际执行该补丁，用退出码区分「刚补上(0)」和「锚点失效(2)」；
 *   3. 产物健康：压缩 bundle 语法检查（node --check）、marker 断言、index.html 注入。
 *
 * 用法：
 *   node scripts/check-pi-web-ui-patches.js            # 校验（缺失才补）
 *   node scripts/check-pi-web-ui-patches.js --quiet    # 只输出失败项与汇总
 *
 * 退出码：0 全部通过 / 1 有失败项 / 2 profile 未找到
 *
 * 与真实页面自检的分工：
 *   本脚本 = 「补丁打上了吗、bundle 还是合法 JS 吗」，秒级；
 *   scripts/check-codex-usage.js = 「浏览器里真的渲染出按钮和状态栏了吗」，十秒级。
 *   两者都要跑，前者通过不代表界面正确。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findWebUiRoot } = require("./pi-web-ui-locate.js");

const ROOT = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");

/**
 * 每个补丁落地后的「特征字符串」断言表。
 * file: server = dist/server 下的服务端产物；web = web/dist/assets 下的前端 bundle；html = web/dist/index.html；wechat-ilink = 已安装的微信插件入口
 * marker 可以是字符串或字符串数组：数组内每一项都必须命中才算已落地。
 * 新增补丁时必须同时补进这张表，否则校验会漏项（漏项按失败处理）。
 */
const MARKERS = {
	"patch-pi-web-ui-usage-cost.js": { file: "server", marker: "usageCost: typeof m.usage?.cost?.total" },
	"patch-pi-web-ui-plugin-live-model.js": { file: "server", marker: "plugin-live-model-patch" },
	// 插件快照按客户端（clientId）取对话：否则多标签/并行对话/子代理下
	// 插件会串页（模型选了 DeepSeek 却显示 Codex 额度）。
	"patch-pi-web-ui-plugin-per-client-conversation.js": {
		file: "server",
		marker: [
			"plugin-per-client-conversation-patch",
			"this.conversationProvider?.(clientId)",
			"service.readConversationForPlugins?.(clientId)",
		],
	},
	"patch-pi-web-ui-hide-forked-sessions.js": { file: "server", marker: "hide-forked-sessions" },
	"patch-pi-web-ui-permanent-project-ignore.js": { file: "server", marker: "managed-recent-project-actions-v3" },
	"patch-pi-web-ui-recovery-ui.js": { file: "html", marker: "pi-recovery-ui-v2" },
	"patch-pi-web-ui-quick-phrase-queue.js": { file: "web", marker: "quick-chip-group" },
	"patch-pi-web-ui-topbar-menu-buttons.js": { file: "web", marker: "topbar-menu-buttons-patch" },
	"patch-pi-web-ui-plugin-topbar-cache.js": { file: "web", marker: "plugin-topbar-cache-patch-v2" },
	"patch-pi-web-ui-plan-board-clear.js": { file: "web", marker: "plan-board-clear-no-confirm-v1" },
	// plan-marker：restore-v2 / legacy-status-migration-v4 两个标记自 0.99.0 起**退役** ——
	// 上游自己持久化计划（PlanManager 落盘 plans.json、按 sessionId）并在快照里直出 plan，
	// 我们那两处注入已删（见 patches/patch-pi-web-ui-plan-marker.js 注释与升级适配记录）。
	// 保留在本表里会让校验永远期待不该存在的 marker。
	"patch-pi-web-ui-plan-marker.js": { file: "server", marker: ["plan-inline-marker-v4", "plan-marker-snapshot-v2", "plan-marker-strict-syntax-v3"] },
	// 入口 bundle 是就地打补丁的（文件名不变），必须让 SW 对入口强制回源重校验，
	// 否则浏览器会长期跑补丁前的老代码（见 docs/升级适配/pi-web-ui-前端补丁缓存失效机制.md）。
	"patch-pi-web-ui-sw-entry-revalidate.js": { file: "sw", marker: "piwork-sw-entry-revalidate-v1" },
	// dangling-tool-calls 自 0.96.0 退役（上游 #332 内建 tailAssistantToolCallIds），已移入 RETIRED。
	// 保留登记会让校验期待那个不该存在的 marker——而重复注入恰恰是服务起不来的原因。
	// pi 内核补丁（改的是 node_modules 里 pi 自己的产物，不是 pi-web-ui 产物）：
	// 根治被污染的 toolCall.name 导致 openai-codex 固定 400（Invalid 'input[N].name'）。
	// 三个标记分别落在 pi-agent-core 的注入点、pi-ai 的注入点与两个注入函数上。
	"patch-pi-invalid-toolcall-names.js": {
		file: "pi-core",
		marker: ["pi-invalid-toolcall-name-v1", "function sanitizeInvalidToolCallNames", "function sanitizeResponsesFunctionName"],
	},
	// 目标审查机制修复：空 feedback 兜底 + 审查输入加入工具/命令证据 + 内置判定粒度。
	// 起因：远程部署类目标连烧 24 轮全 fail（审查者看不到远程证据、未声称的后续阶段
	// 也被算 fail 理由、空 feedback 让 Agent 空跑）。marker 与关键结构同时断言。
	"patch-pi-web-ui-goal-review.js": {
		file: "server",
		marker: [
			"goal-review-evidence-v1",
			"export function ensureReviewerFeedback",
			"collectEvidenceDigest(session, cwd",
			"# Scoring rules (mandatory",
			"【判定规则（强制，覆盖此前任何措辞）】",
			// 只看提示词不够：0.99.0 的证据必须真的取自执行者会话、兜底真的在 verdict 落地处被调用。
			"const execSession = this.host.getConv?.(execId)?.session;",
			"verdict.feedback = ensureReviewerFeedback(verdict.feedback, feedback);",
			// 一行 stderr 日志：把「证据段到底空不空」变成可观测事实（审查指令不经 WS 帧下发）。
			"[goal-evidence] digest=",
		],
	},
	// 模型可见性：服务端只下发免费/订阅/白名单模型，并给每项带 free 字段。
	"patch-pi-web-ui-free-models-only.js": { file: "server", marker: "free-models-only-v2" },
	"patch-pi-web-ui-prompt-snapshot-budget.js": {
		file: "server",
		marker: ["piwork-prompt-snapshot-budget-v1", "piwork-prompt-snapshot-lock-cleanup-v2", "piwork-prompt-snapshot-lock-retry-v3", "AbortSignal.timeout(750)", "gitDirOf(cwd, signal)", "runGit(cwd, [\"add\", \"-A\"], env, signal)"],
	},
	// 免费模型绿色「免费」徽标：就地改前端入口 bundle（改完需刷入口缓存，见 entry cache bust）。
	"patch-pi-web-ui-free-model-badge.js": { file: "web", marker: "free-model-badge-v1" },
	// 微信通道插件不在 pi-web-ui 的 npm 包目录中，需单独检查其已安装入口。
	"patch-pi-web-ui-wechat-ilink.js": { file: "wechat-ilink", marker: "wechat-ilink-safe-reply-v1" },
};

/**
 * 已退役的补丁：自某个 pi-web-ui 版本起上游内建了等价能力，不再需要打进产物。
 * 它们仍保留在本表之外的文件里（旧版本 profile 还需要），但**不得再列入新版本 profile**。
 */
const RETIRED = {
	"patch-pi-web-ui-quick-phrase-queue.js": "0.94.1 起用上游内建的右键排队（chip 的 onContextMenu），自加的 ⏳ 按钮已移除（--remove 可清除已注入的）",
	"patch-pi-web-ui-recovery-ui.js": "0.94.1 起不再注入：顶栏「重连」插件在断连时直连 watchdog（127.0.0.1:8790），能力已覆盖浮层（用户确认删除；可用 --remove 清除已注入的块）",
	"patch-pi-web-ui-usage-cost.js": "0.94.1 起上游 serialize 自己下发 usageCost（缺省 undefined，与本补丁的 null 对插件等价）",
	"patch-pi-web-ui-hide-forked-sessions.js": "0.94.1 起上游 agent-service 自己按 parentSessionPath 去重 fork 链尾",
	"patch-pi-web-ui-permanent-project-ignore.js": "0.94.1 起上游 client-state 自己维护全局 removedProjects 与打开即清标记",
	"apply-stop-button.ps1": "0.95.0 起上游 `.inputbox .btn.stop` 自带 `--stop-red` 与 `stop-pulse`；旧脚本只保留给历史版本 profile，当前版本不得执行",
	"patch-pi-web-ui-dangling-tool-calls.js": "0.96.0 起上游 dangling-tools 自带 `export function tailAssistantToolCallIds`（#332，守卫比本补丁更严：除 error/aborted 外遇到 user 消息也停止回溯）；再注入会造成同名函数重复声明、服务端 bundle SyntaxError（2026-09-29 真实故障）。脚本保留仅用于清除历史注入的残留块",
};

const results = [];
const fail = (name, detail) => results.push({ ok: false, name, detail });
const pass = (name, detail) => results.push({ ok: true, name, detail });

function readJson(p) {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

/** 读某个包的版本号：包可能在 pi-web-ui 自己的 node_modules 下（bundled），也可能在全局 npm 目录。 */
function packageVersion(name) {
	const webRoot = findWebUiRoot();
	const candidates = [
		path.join(webRoot || "", "node_modules", ...name.split("/"), "package.json"),
		path.join(process.env.APPDATA || "", "npm", "node_modules", ...name.split("/"), "package.json"),
	];
	for (const c of candidates) {
		const j = readJson(c);
		if (j?.version) return j.version;
	}
	return null;
}

function webFile(kind) {
	const webRoot = findWebUiRoot();
	if (!webRoot) return null;
	if (kind === "html") return path.join(webRoot, "web", "dist", "index.html");
	if (kind === "sw") return path.join(webRoot, "web", "dist", "sw.js");
	if (kind === "wechat-ilink") {
		const bundled = path.join(path.dirname(webRoot), ".pi-web", "plugins", "wechat-ilink", "index.mjs");
		const fallback = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi-web", "plugins", "wechat-ilink", "index.mjs");
		return fs.existsSync(bundled) ? bundled : fallback;
	}
	if (kind === "server") {
		const dir = path.join(webRoot, "dist", "server");
		if (!fs.existsSync(dir)) return null;
		const files = [];
		const walk = (current) => {
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
			}
		};
		walk(dir);
		return files;
	}
	if (kind === "pi-core") {
		// pi 自己的产物：agent-loop.js（写账本前净化）+ openai-responses-shared.js（发请求前兜底），
		// 每个 pi 安装副本各一份（详见 scripts/pi-core-locate.js 头注释）。
		const { piCodingAgentRoots, resolvePiDep } = require("./pi-core-locate.js");
		const files = [];
		for (const root of piCodingAgentRoots()) {
			const core = resolvePiDep(root, "pi-agent-core");
			const ai = resolvePiDep(root, "pi-ai");
			if (core) files.push(path.join(core, "dist", "agent-loop.js"));
			if (ai) files.push(path.join(ai, "dist", "api", "openai-responses-shared.js"));
		}
		return files;
	}
	const dir = path.join(webRoot, "web", "dist", "assets");
	if (!fs.existsSync(dir)) return null;
	return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
}

function readAllOf(kind) {
	const f = webFile(kind);
	if (!f) return "";
	const files = Array.isArray(f) ? f : [f];
	return files.map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "")).join("\n");
}

function runPatch(file) {
	const full = path.join(ROOT, file);
	if (!fs.existsSync(full)) return { code: 127, out: "文件不存在" };
	const cmd = file.endsWith(".ps1") ? "powershell" : process.execPath;
	const args = file.endsWith(".ps1")
		? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", full]
		: [full];
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000 });
	return { code: r.status ?? 1, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

// ---- 1. 版本与 profile ----
const webRoot = findWebUiRoot();
if (!webRoot) {
	console.error("✗ 找不到 pi-web-ui 安装目录（便携 install.json 与 npm 全局目录都没有）");
	process.exit(2);
}
const webVer = readJson(path.join(webRoot, "package.json"))?.version ?? null;
const piVer = packageVersion("@earendil-works/pi-coding-agent");
if (!webVer || !piVer) {
	console.error(`✗ 版本识别失败：pi-web-ui=${webVer} pi=${piVer}`);
	process.exit(2);
}
const profileRel = path.join("configs", "pi-web-ui-profiles", `pi-${piVer}_web-${webVer}.json`);
const profile = readJson(path.join(ROOT, profileRel));
if (!profile) {
	console.error(`✗ 未找到匹配 profile：${profileRel}`);
	console.error("  升级 pi / pi-web-ui 后必须新建对应版本档案。");
	process.exit(2);
}
pass("profile", `pi-${piVer}_web-${webVer}.json（${profile.patches.length} 项）`);

// ---- 2. 压缩产物语法（只查被补丁改过的文件：全量查 85 个文件白耗 5 秒）----
const markersByKind = new Map();
for (const spec of Object.values(MARKERS)) {
	if (!markersByKind.has(spec.file)) markersByKind.set(spec.file, []);
	markersByKind.get(spec.file).push(...(Array.isArray(spec.marker) ? spec.marker : [spec.marker]));
}
for (const [kind, markers] of markersByKind) {
	if (kind === "html") continue; // index.html 不是 JS，无需语法检查
	for (const p of [webFile(kind)].flat().filter(Boolean)) {
		if (!fs.existsSync(p)) continue;
		const text = fs.readFileSync(p, "utf8");
		if (!markers.some((m) => text.includes(m))) continue; // 没被补丁动过，不查
		const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8", timeout: 30000 });
		if (r.status === 0) pass(`syntax ${kind}`, path.basename(p));
		else fail(`syntax ${kind}`, `${path.basename(p)} 不是合法 JS：${(r.stderr || "").split("\n")[0]}`);
	}
}

// ---- 3. 逐项校验补丁 ----
const uncovered = [];
for (const rel of profile.patches) {
	const base = path.basename(rel);
	if (RETIRED[base]) {
		fail(`patch ${base}`, `已退役（${RETIRED[base]}），不应再列入 profile`);
		continue;
	}
	const spec = MARKERS[base];
	if (!spec) {
		uncovered.push(rel);
		fail(`patch ${base}`, "未登记到本脚本的特征字符串表，无法校验");
		continue;
	}
	const wanted = Array.isArray(spec.marker) ? spec.marker : [spec.marker];
	const before = readAllOf(spec.file);
	if (wanted.every((m) => before.includes(m))) {
		pass(`patch ${base}`, "已落地");
		continue;
	}
	// 缺失才实际执行：0=刚补上，2=锚点失效（源码变了）
	const r = runPatch(rel);
	if (r.code === 0) {
		// 补丁可能只命中一半（退出 0 却只改了一处）：重打后必须逐项复验。
		const after = readAllOf(spec.file);
		const stillMissing = wanted.filter((m) => !after.includes(m));
		if (stillMissing.length === 0) pass(`patch ${base}`, "已重新应用");
		else fail(`patch ${base}`, `重新应用后仍缺少标记：${stillMissing.join(", ")}`);
	} else if (r.code === 2) {
		fail(`patch ${base}`, "锚点失效：pi-web-ui 源码已变化，必须适配");
	} else {
		fail(`patch ${base}`, `退出码 ${r.code}：${r.out.split("\n").slice(-1)[0]}`);
	}
}
// 不比对「profile 项数 == 断言表项数」：断言表是跨版本的超集，各版本 profile 因补丁
// 退役/新增而项数不同（如 0.94.1 退役了 fork 去重与最近项目两项）。真正要守的是
// 「profile 里每一项都能被校验」——上面逐项检查已覆盖（未登记者直接判失败）。

// plan marker 的真实装配链：只检查 marker-service 的 ctx.host 不够，AgentService
// 创建 MarkerService 时也必须传入同一个 PlanManager，否则界面会提示服务不可用。
const agentServiceFile = path.join(webRoot, "dist", "server", "agent-service.js");
const agentServiceText = fs.existsSync(agentServiceFile) ? fs.readFileSync(agentServiceFile, "utf8") : "";
if (/this\.markerSvc = new MarkerService\(\{[\s\S]*?planManager: this\.planManager,[\s\S]*?flushSnapshot: \(\) => this\.flushSnapshot\(\),/.test(agentServiceText)) {
	pass("plan marker host", "AgentService 已注入 planManager");
} else {
	fail("plan marker host", "AgentService 未向 MarkerService 注入 planManager");
}

// ---- 3.5 dev 源码补丁（vite 5173 直接 serve source checkout，不读 web/dist）----
// 少了这道断言就会出现「上面全是绿的、5173 上确认框却还在」：补丁只打 npm bundle，
// dev 页面用的是另一份源码。2026-09-29 实际踩过，用户以为“修过一遍又回去了”。
{
	const devSrc = path.join(ROOT, "projects", "pi-web-ui-source", "web", "src", "components", "PlanBoard.tsx");
	if (!fs.existsSync(devSrc)) {
		pass("dev source plan-board-clear", "无 source checkout，跳过");
	} else {
		const text = fs.readFileSync(devSrc, "utf8");
		const hasMarker = text.includes("plan-board-clear-no-confirm-v1");
		const hasConfirm = /window\.confirm\("确定要清空当前任务计划看板吗？"\)/.test(text);
		if (hasMarker && !hasConfirm) pass("dev source plan-board-clear", "PlanBoard.tsx 已去 confirm");
		else if (hasConfirm) fail("dev source plan-board-clear", "源码仍含 window.confirm —— 5173 页面清空会卡");
		else fail("dev source plan-board-clear", "缺 marker，无法确认补丁状态（可能被上游还原）");
	}
}

// ---- 3.6 dev 源码：顶栏原生菜单项（同样是“只打 bundle 就漏了 dev”的重灾区）----
{
	const devSlots = path.join(ROOT, "projects", "pi-web-ui-source", "web", "src", "ui-slots.ts");
	if (!fs.existsSync(devSlots)) {
		pass("dev source topbar-menu-buttons", "无 source checkout，跳过");
	} else {
		const text = fs.readFileSync(devSlots, "utf8");
		const set = text.match(/REQUIRED_TOPBAR_ITEM_IDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
		const six = ["host:browser", "host:sound", "host:language", "host:theme", "host:update", "host:github"];
		const inSet = set ? six.every((id) => set[1].includes(`"${id}"`)) : false;
		const hasMarker = text.includes("topbar-menu-buttons-patch");
		if (inSet && hasMarker) pass("dev source topbar-menu-buttons", "六项已进顶栏常驻集合");
		else if (!set) fail("dev source topbar-menu-buttons", "找不到 REQUIRED_TOPBAR_ITEM_IDS —— 上游改了常量，必须适配");
		else if (!inSet) fail("dev source topbar-menu-buttons", `常驻集合缺项（六项只命中 ${six.filter((id) => set[1].includes(`"${id}"`)).length} 个）—— 5173 顶栏会少按钮`);
		else fail("dev source topbar-menu-buttons", "缺 marker，无法确认补丁状态");
	}
}

// ---- 4. 入口 bundle 缓存自愈：key 必须与当前 bundle 内容 hash 一致 ----
// 这是「补丁已落地、浏览器却还在跑老代码」的防线：index.html 里的自愈挡块一旦
// 与 bundle 内容脱节，浏览器就会永远拿旧版（2026-09-25 实际踩过：看板补丁 04:35
// 落地，index.html 的 key 还停在 22:55 的旧 hash，用户第二天仍在弹旧版确认框）。
try {
	const { refreshEntryCacheBust } = require(path.join(ROOT, "scripts", "pi-web-ui-entry-cache-bust.js"));
	const before = refreshEntryCacheBust(true);
	if (!before.changed) {
		pass("entry cache bust", `已对齐到 bundle hash ${before.hash}`);
	} else {
		refreshEntryCacheBust(false);
		const after = refreshEntryCacheBust(true);
		if (after.changed) fail("entry cache bust", "重新对齐后仍与 bundle 内容不一致");
		else pass("entry cache bust", `已重新对齐到 bundle hash ${after.hash}`);
	}
} catch (error) {
	fail("entry cache bust", error.message);
}

// ---- 5. pi 内核补丁：逐副本断言 ----
// 上面的 marker 检查是把某类文件拼成一大段文本再 match，会放过「只补了其中一份副本」的情况；
// 而 pi 内核在机器上可能存在 pi-web-ui 内嵌、全局 npm、源码项目三份，漏一份就等于那个入口没修。
try {
	const { piCodingAgentRoots, resolvePiDep } = require(path.join(ROOT, "scripts", "pi-core-locate.js"));
	const targets = [];
	for (const root of piCodingAgentRoots()) {
		const core = resolvePiDep(root, "pi-agent-core");
		const ai = resolvePiDep(root, "pi-ai");
		if (core) targets.push({ root, file: path.join(core, "dist", "agent-loop.js"), needle: "sanitizeInvalidToolCallNames(message)" });
		if (ai) targets.push({ root, file: path.join(ai, "dist", "api", "openai-responses-shared.js"), needle: "sanitizeResponsesFunctionName(toolCall.name)" });
	}
	const missing = targets.filter((t) => !fs.existsSync(t.file) || !fs.readFileSync(t.file, "utf8").includes(t.needle));
	if (targets.length === 0) fail("pi core patch", "没有发现任何 pi 内核安装副本");
	else if (missing.length) fail("pi core patch", `未打补丁的副本：${missing.map((t) => `${path.basename(t.file)} @ ${t.root}`).join(" / ")}`);
	else pass("pi core patch", `${targets.length} 个内核产物全部已打补丁`);
} catch (error) {
	fail("pi core patch", error.message);
}

// ---- 6. 汇总 ----
const failed = results.filter((r) => !r.ok);
if (!QUIET) {
	for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name} — ${r.detail}`);
} else if (failed.length) {
	for (const r of failed) console.log(`✗ ${r.name} — ${r.detail}`);
}
console.log(
	`\n${failed.length === 0 ? "✓ 全部通过" : `✗ ${failed.length} 项失败`}：` +
		`pi-web-ui ${webVer} / pi ${piVer}，共 ${results.length} 项检查，` +
		`profile ${profile.patches.length} 个补丁${uncovered.length ? `（${uncovered.length} 项未覆盖）` : ""}`,
);
console.log("提示：本脚本只校验补丁落地，界面是否真的渲染出来请再跑 node scripts/check-codex-usage.js");
process.exit(failed.length === 0 ? 0 : 1);
