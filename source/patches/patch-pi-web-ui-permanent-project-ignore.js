#!/usr/bin/env node
/**
 * 为 pi-web-ui 增加「永久忽略最近项目」名单。
 *
 * 原生 removedProjects 只是临时墓碑：重新打开同一 cwd 时 ClientStateStore.remember()
 * 会删除墓碑；此外 AgentService.withCurrentCwd() 会无条件把当前 cwd 塞回列表。
 * 因此仅编辑 ~/.pi-web/client-state.json 无法让项目永久隐藏。
 *
 * 本补丁读取 client-state.json 的全局段：
 *   __piweb_global__.permanentRemovedProjects: ["C:\\Users\\X\\Desktop\\test", ...]
 *
 * 由 scripts/pi-web-ui-forget-project.js 写入该名单。名单中的项目即使被重新打开、
 * 新建浏览器 clientId 或服务重启后被 session 扫描发现，也不会出现在「最近项目」。
 *
 * 幂等；源码锚点不匹配时退出 2，不修改任何文件。
 */
const fs = require("fs");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const clientStateFile = locateWebUiFile("dist", "server", "client-state.js");
const agentServiceFile = locateWebUiFile("dist", "server", "agent-service.js");
const marker = "permanent-project-ignore";

const rememberNeedle = `        const state = (all[clientId] ??= { projects: [] });
        state.lastCwd = cwd;
        const now = Date.now();`;
const rememberReplacement = `        const state = (all[clientId] ??= { projects: [] });
        // ${marker}: 全局永久名单优先于「重新打开就取消墓碑」的默认行为。
        // 仍保存 lastCwd，保证当前正在工作的项目不会因隐藏侧栏条目而中断；
        // 但不写 recent projects，并补回该 client 的墓碑以兼容旧调用路径。
        const permanent = new Set(all.__piweb_global__?.permanentRemovedProjects ?? []);
        if (permanent.has(cwd)) {
            state.lastCwd = cwd;
            state.projects = state.projects.filter((p) => p.path !== cwd);
            const removed = new Set(state.removedProjects ?? []);
            removed.add(cwd);
            state.removedProjects = [...removed];
            this.save();
            return;
        }
        state.lastCwd = cwd;
        const now = Date.now();`;

const removedNeedle = `    getRemovedProjects(clientId) {
        return this.load()[clientId]?.removedProjects ?? [];
    }`;
const removedReplacement = `    getRemovedProjects(clientId) {
        const all = this.load();
        // ${marker}: 全局名单适用于新旧所有浏览器 clientId，不能只放在单个 client state 里。
        const removed = new Set(all[clientId]?.removedProjects ?? []);
        for (const cwd of all.__piweb_global__?.permanentRemovedProjects ?? []) removed.add(cwd);
        return [...removed];
    }`;

const currentNeedle = `    withCurrentCwd(projects, now) {
        if (projects.some((p) => p.path === this.cwd)) {`;
const currentReplacement = `    withCurrentCwd(projects, now) {
        // ${marker}: 用户明确隐藏的项目即使正是当前 cwd，也不得被无条件重新加入最近项目。
        if (this.stateStore.getRemovedProjects(this.clientId).includes(this.cwd)) return projects;
        if (projects.some((p) => p.path === this.cwd)) {`;

function patch(file, changes) {
    if (!file || !fs.existsSync(file)) throw new Error(`找不到目标文件：${file || "(空)"}`);
    let source = fs.readFileSync(file, "utf8");
    if (source.includes(marker)) return false;
    for (const [needle] of changes) {
        const count = source.split(needle).length - 1;
        if (count !== 1) throw new Error(`版本锚点不匹配（命中 ${count} 次）：${file}`);
    }
    for (const [needle, replacement] of changes) source = source.replace(needle, replacement);
    fs.writeFileSync(file, source, "utf8");
    return true;
}

try {
    const a = patch(clientStateFile, [[rememberNeedle, rememberReplacement], [removedNeedle, removedReplacement]]);
    const b = patch(agentServiceFile, [[currentNeedle, currentReplacement]]);
    console.log(a || b ? "✓ 已应用永久忽略最近项目补丁" : "✓ 永久忽略最近项目补丁已存在");
} catch (err) {
    console.error("✗ " + err.message);
    process.exit(2);
}
