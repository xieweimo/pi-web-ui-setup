#!/usr/bin/env node
/**
 * 让插件快照支持「按浏览器客户端取对话」，并让全局兜底跳过子代理会话。
 *
 * 背景（两件真实事故）：
 * 1) pluginMgr.conversationProvider 只提供「全客户端最近活跃对话」（at 最大者）。只要有第二个
 *    标签页、并行对话或子代理在跑，插件拿到的就不是当前页面正在看的那个对话 —— 表现就是
 *    「模型选了 DeepSeek，底部却显示 openai-codex 的额度窗口」；
 * 2) 全局兜底不区分子代理：子代理会话往往更“活跃”，会把页面真正在看的对话挤掉。
 *
 * 注意：会话文件路径 `sessionFile`（以及 sessionId / sessionDir / model）自 pi-web-ui **0.99.0**
 * 起已由宿主**原生**提供（见 server/agent-service.js 的 readConversationForPlugins 返回值），
 * 本补丁不再自己往快照里加字段 —— 重复加只会造出同名键覆盖原生值。
 *
 * 本补丁做四件事：
 *  1) ClientSession.readConversationForPlugins(conversationId?)：可指定对话，并带上 isSubagent；
 *  2) 聚合层 readConversationForPlugins(clientId?)：传了 clientId 就取该客户端当前打开的
 *     对话（cs.activeId），否则回落到「最近活跃的非子代理对话」；
 *  3) PluginManager.getActiveConversation(clientId) 与插件 host.getActiveConversation(clientId)
 *     把 clientId 透传下去；
 *  4) index.js 的 conversationProvider 接收 clientId。
 *
 * 幂等（逐条判断，已应用就跳过）；源码版本不匹配时退出码 2，且不阻断服务。
 */
const fs = require("fs");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const files = {
	agentService: locateWebUiFile("dist", "server", "agent-service.js"),
	plugins: locateWebUiFile("dist", "server", "plugins.js"),
	index: locateWebUiFile("dist", "server", "index.js"),
};
for (const [key, file] of Object.entries(files)) {
	if (!file || !fs.existsSync(file)) {
		console.error(`target not found (${key})`);
		process.exit(1);
	}
}
const read = (f) => fs.readFileSync(f, "utf8");
const write = (f, s) => fs.writeFileSync(f, s, "utf8");
const count = (s, needle) => s.split(needle).length - 1;

const edits = [
	{
		file: files.agentService,
		label: "agent-service: ClientSession 可指定对话",
		// 已经打过这处补丁的判据
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
		file: files.agentService,
		label: "agent-service: 快照带 isSubagent",
		// 只认我们这处：原生代码里没有这行（sessionFile 已由 0.99.0 原生提供，本补丁不再插手）。
		applied: "isSubagent: Boolean(target.isSubagent),",
		needle: `                messages: this.messagesOf(target),`,
		replacement: `                // plugin-per-client-conversation-patch: 全局兜底要能跳过子代理会话
                // （会话文件路径 sessionFile 自 pi-web-ui 0.99.0 起由宿主原生提供，这里不再加）。
                isSubagent: Boolean(target.isSubagent),
                messages: this.messagesOf(target),`,
	},
	{
		file: files.agentService,
		label: "agent-service: 聚合层按 clientId",
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
		file: files.plugins,
		label: "plugins: getActiveConversation(clientId)",
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
		file: files.plugins,
		label: "plugins: 插件 host 透传 clientId",
		applied: "getActiveConversation: (clientId) => self.getActiveConversation(clientId),",
		needle: `            getActiveConversation: () => self.getActiveConversation(),`,
		replacement: `            getActiveConversation: (clientId) => self.getActiveConversation(clientId),`,
	},
	{
		file: files.index,
		label: "index: conversationProvider(clientId)",
		applied: "service.readConversationForPlugins?.(clientId) ?? null;",
		needle: `pluginMgr.conversationProvider = () => service.readConversationForPlugins?.() ?? null;`,
		replacement: `pluginMgr.conversationProvider = (clientId) => service.readConversationForPlugins?.(clientId) ?? null;`,
	},
];

const sources = new Map();
for (const e of edits) if (!sources.has(e.file)) sources.set(e.file, read(e.file));

const done = [];
for (const e of edits) {
	const src = sources.get(e.file);
	if (src.includes(e.applied)) {
		done.push(`已存在 · ${e.label}`);
		continue;
	}
	const hits = count(src, e.needle);
	if (hits !== 1) {
		console.error(`✗ pi-web-ui 源码已变化，未应用补丁（${e.label}：命中 ${hits} 次）`);
		process.exit(2);
	}
	sources.set(e.file, src.replace(e.needle, e.replacement));
	done.push(`已应用 · ${e.label}`);
}

for (const e of edits) {
	const next = sources.get(e.file);
	if (next !== read(e.file)) write(e.file, next);
}
console.log("✓ per-client conversation 补丁：");
for (const line of done) console.log(`  · ${line}`);
