#!/usr/bin/env node
/**
 * codex-usage 宿主补丁（自包含，随插件一起分发）
 *
 * 作用：给 pi-web-ui 的插件快照加上「按浏览器客户端（clientId）取对话」的能力，
 * 让本插件在多标签页 / 并行对话 / 子代理同时存在时，仍然只显示**本页面**正在看的
 * 那个对话的额度与成本（不打这个补丁时，插件会退化成“全局最近活跃对话”，
 * 多标签下会显示 `⚡ 同步中…`，而不是把别的对话的数字报给你）。
 *
 * 为什么必须打补丁：截至 pi-web-ui 0.99.0，官方插件 API 无法让插件知道
 * 「本页面在看哪个会话」——
 *   · host.getActiveConversation() 不接收 clientId，只返回全局最近活跃对话；
 *   · host.conversations.list() 的运行中会话只给 {id,title,cwd,kind,isStreaming}，不给 sessionFile；
 *   · onStats（按会话扇出统计）已在 0.98.0 被上游删除；
 *   · host.conversations.get(id) 只在 id 恰好是当前活跃会话时才返回快照。
 * 该接口缺口已作为提案提交上游（见仓库 upstream/ 目录）。
 *
 * 注意：本脚本修改 pi-web-ui 的**编译产物**（dist/*.js），与版本强绑定：
 *   · 锚点失配时以退出码 2 退出，绝不模糊替换；
 *   · 升级 pi-web-ui 后重跑一次即可（幂等：已打过会跳过）。
 *
 * 用法：
 *   node host-patch/apply.cjs             # 应用（幂等）
 *   node host-patch/apply.cjs --dry-run    # 只预览会改哪些文件，不写盘
 *   PI_WEB_UI_DIR=<pi-web-ui 包目录> node host-patch/apply.cjs   # 手动指定安装目录
 *
 * 退出码：0 = 已应用或已存在；1 = 找不到 pi-web-ui / 产物缺失；2 = 锚点失配；3 = 写盘后语法校验失败
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** 定位 pi-web-ui 安装目录（覆盖 npm 全局 / 便携 node / 源码 checkout / 环境变量指定）。 */
function findWebUiRoot() {
	const candidates = [];
	const envDir = (process.env.PI_WEB_UI_DIR || "").trim();
	if (envDir) candidates.push(envDir);
	for (const base of [process.cwd(), __dirname]) {
		try {
			candidates.push(path.dirname(require.resolve("pi-web-ui/package.json", { paths: [base] })));
		} catch {
			/* 该基准下解析不到，继续试下一个 */
		}
	}
	const nodeDir = path.dirname(process.execPath);
	candidates.push(path.join(nodeDir, "node_modules", "pi-web-ui"));
	candidates.push(path.join(path.dirname(nodeDir), "node_modules", "pi-web-ui"));
	const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
	candidates.push(path.join(appdata, "npm", "node_modules", "pi-web-ui"));
	candidates.push(path.join(os.homedir(), ".npm-global", "lib", "node_modules", "pi-web-ui"));
	candidates.push("/usr/local/lib/node_modules/pi-web-ui");
	candidates.push("/usr/lib/node_modules/pi-web-ui");
	for (const c of candidates) {
		try {
			if (c && fs.existsSync(path.join(c, "package.json"))) return c;
		} catch {
			/* 忽略不可读路径 */
		}
	}
	return null;
}

/** dist 产物路径（kind: agent-service | plugins | index）。 */
function distFile(webRoot, kind) {
	return path.join(webRoot, "dist", "server", `${kind}.js`);
}

/**
 * 锚点表。导出给 e2e 测试用：测试会把 patched 产物按「replacement → needle」反向还原成
 * 未打补丁的产物，再跑本脚本并逐字节比对，确保补丁与手工打的结果完全等价。
 */
const EDITS = [
	{
		kind: "agent-service",
		label: "ClientSession.readConversationForPlugins(conversationId)",
		applied: "plugin-per-client-conversation-patch: 指定对话优先",
		needle: `    readConversationForPlugins() {
        try {
            let target = null;
            for (const c of this.convs.values()) {
                if (!target || c.lastActiveAt > target.lastActiveAt)
                    target = c;
            }
            if (!target)
                return null;`,
		replacement: `    readConversationForPlugins(conversationId) {
        try {
            let target = null;
            // plugin-per-client-conversation-patch: 指定对话优先（插件按页面取“那个客户端正在看的会话”）。
            const wanted = String(conversationId ?? "").trim();
            if (wanted) {
                try {
                    target = this.convs.get(wanted) ?? null;
                }
                catch {
                    target = null;
                }
            }
            if (!target) {
                for (const c of this.convs.values()) {
                    if (!target || c.lastActiveAt > target.lastActiveAt)
                        target = c;
                }
            }
            if (!target)
                return null;`,
	},
	{
		kind: "agent-service",
		label: "快照补 isSubagent（全局兜底跳过子代理）",
		applied: "isSubagent: Boolean(target.isSubagent),",
		needle: `                messages: this.messagesOf(target),`,
		replacement: `                // plugin-per-client-conversation-patch: 全局兜底要能跳过子代理会话
                // （会话文件路径 sessionFile 自 pi-web-ui 0.99.0 起由宿主原生提供，这里不再加）。
                isSubagent: Boolean(target.isSubagent),
                messages: this.messagesOf(target),`,
	},
	{
		kind: "agent-service",
		label: "聚合层 readConversationForPlugins(clientId)",
		applied: "return best ?? any;",
		needle: `    /** 插件用：全客户端最近活跃对话的快照（at 最大者即“当前打开的对话”）。 */
    readConversationForPlugins() {
        let best = null;
        for (const cs of this.clients.values()) {
            try {
                const s = cs.readConversationForPlugins();
                if (s && (!best || s.at > best.at))
                    best = s;
            }
            catch {
                /* 单客户端坏了不影响其他 */
            }
        }
        return best;
    }`,
		replacement: `    /** 插件用：传 clientId = 该浏览器客户端当前打开的对话（插件按页面隔离用）；
     *  不传时回落到全局最近活跃对话，并跳过子代理会话（与 llmEnvForPlugins 对齐）。 */
    readConversationForPlugins(clientId) {
        const wanted = String(clientId ?? "").trim();
        if (wanted) {
            const cs = this.clients.get(wanted);
            if (cs) {
                try {
                    const s = cs.readConversationForPlugins(cs.activeId);
                    if (s)
                        return s;
                }
                catch {
                    /* 该客户端快照异常时回落全局 */
                }
            }
        }
        let best = null;
        let any = null;
        for (const cs of this.clients.values()) {
            try {
                const s = cs.readConversationForPlugins();
                if (!s)
                    continue;
                if (!any || s.at > any.at)
                    any = s;
                if (s.isSubagent)
                    continue;
                if (!best || s.at > best.at)
                    best = s;
            }
            catch {
                /* 单客户端坏了不影响其他 */
            }
        }
        return best ?? any;
    }`,
	},
	{
		kind: "plugins",
		label: "PluginManager.getActiveConversation(clientId)",
		applied: "plugin-per-client-conversation-patch: clientId 有值",
		needle: `    getActiveConversation() {
        let snap;
        try {
            snap = this.conversationProvider?.() ?? null;
        }`,
		replacement: `    getActiveConversation(clientId) {
        let snap;
        try {
            // plugin-per-client-conversation-patch: clientId 有值 = 取该页面正在看的对话（无则各自回落）。
            snap = this.conversationProvider?.(clientId) ?? null;
        }`,
	},
	{
		kind: "plugins",
		label: "插件 host 透传 clientId",
		applied: "getActiveConversation: (clientId) => self.getActiveConversation(clientId),",
		needle: `            getActiveConversation: () => self.getActiveConversation(),`,
		replacement: `            getActiveConversation: (clientId) => self.getActiveConversation(clientId),`,
	},
	{
		kind: "index",
		label: "index.ts 接线 conversationProvider(clientId)",
		applied: "service.readConversationForPlugins?.(clientId) ?? null;",
		needle: `pluginMgr.conversationProvider = () => service.readConversationForPlugins?.() ?? null;`,
		replacement: `pluginMgr.conversationProvider = (clientId) => service.readConversationForPlugins?.(clientId) ?? null;`,
	},
];

function main() {
	const dryRun = process.argv.includes("--dry-run");
	const webRoot = findWebUiRoot();
	if (!webRoot) {
		console.error("✗ 找不到 pi-web-ui 安装目录。");
		console.error("  请用 PI_WEB_UI_DIR=<pi-web-ui 包目录> 显式指定，例如：");
		console.error('  PI_WEB_UI_DIR="$APPDATA/npm/node_modules/pi-web-ui" node host-patch/apply.cjs');
		return 1;
	}
	let webVersion = "?";
	try {
		webVersion = JSON.parse(fs.readFileSync(path.join(webRoot, "package.json"), "utf8")).version;
	} catch {
		/* 版本读不到不影响打补丁 */
	}
	console.log(`pi-web-ui: ${webRoot}（v${webVersion}）${dryRun ? "  [dry-run]" : ""}`);

	const sources = new Map();
	for (const kind of new Set(EDITS.map((e) => e.kind))) {
		const file = distFile(webRoot, kind);
		if (!fs.existsSync(file)) {
			console.error(`✗ 产物缺失：${file}`);
			console.error("  该 pi-web-ui 安装可能不完整，或版本过旧（本补丁适配 0.99.0 的产物布局）。");
			return 1;
		}
		sources.set(kind, fs.readFileSync(file, "utf8"));
	}

	const results = [];
	for (const e of EDITS) {
		const src = sources.get(e.kind);
		if (src.includes(e.applied)) {
			results.push(["已存在", e.label]);
			continue;
		}
		const hits = src.split(e.needle).length - 1;
		if (hits !== 1) {
			console.error(`✗ 锚点失配，未应用补丁：${e.label}（命中 ${hits} 次，应为 1）`);
			console.error("  说明这个 pi-web-ui 版本的产物与补丁不匹配：请升级本插件，或等插件适配该版本。");
			return 2;
		}
		sources.set(e.kind, src.replace(e.needle, e.replacement));
		results.push(["已应用", e.label]);
	}

	const changed = [...sources.entries()].filter(([kind, next]) => next !== fs.readFileSync(distFile(webRoot, kind), "utf8"));
	if (dryRun) {
		console.log(`\n会修改 ${changed.length} 个文件：`);
		for (const [kind] of changed) console.log(`  · ${distFile(webRoot, kind)}`);
		console.log("（--dry-run：未写盘）");
	} else {
		for (const [kind, next] of changed) fs.writeFileSync(distFile(webRoot, kind), next, "utf8");
		// 改完立刻语法校验：产物被写坏会让服务起不来，这是最后一道闸。
		for (const [kind] of changed) {
			const file = distFile(webRoot, kind);
			const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
			if (r.status !== 0) {
				console.error(`✗ 语法校验失败：${file}\n${r.stderr || ""}`);
				console.error("  请重装 pi-web-ui（npm i -g pi-web-ui）后重跑本脚本。");
				return 3;
			}
		}
	}

	for (const [state, label] of results) console.log(`  ${state === "已应用" ? "✓" : "·"} ${state} ${label}`);
	console.log(
		changed.length === 0
			? "\n✓ 宿主补丁已是最新，无需改动。"
			: `\n✓ 宿主补丁已写入 ${changed.length} 个产物文件。`,
	);
	console.log("  重启 pi-web-ui 服务（或在设置里点“重启网页服务”）后生效。");
	return 0;
}

if (require.main === module) process.exit(main());

module.exports = { findWebUiRoot, distFile, EDITS, main };
