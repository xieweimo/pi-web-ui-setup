#!/usr/bin/env node
/**
 * 让「最近项目 → 删除」成为持久、全局且由用户管理的操作。
 *
 * 原生行为的问题：removeProject() 只写当前 browser client 的墓碑；重新打开 cwd 时
 * remember() 又会删掉墓碑，AgentService.withCurrentCwd() 还会把当前 cwd 强插回列表。
 * 结果是用户删掉的项目一启动便“复活”。
 *
 * 修复后的规则：任何 UI 删除操作都将路径写入
 * ~/.pi-web/client-state.json 的 __piweb_global__.permanentRemovedProjects。
 * 该名单适用于所有浏览器 clientId；重开项目只允许继续工作，不会恢复最近项目条目。
 * 没有任何项目路径被硬编码，test 只是用户先前删除的一项。
 *
 * 兼容已应用的 v1 补丁；幂等；版本锚点不匹配时退出 2，不修改文件。
 */
const fs = require("fs");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const clientStateFile = locateWebUiFile("dist", "server", "client-state.js");
const agentServiceFile = locateWebUiFile("dist", "server", "agent-service.js");
const v1Marker = "permanent-project-ignore";
const marker = "persistent-recent-project-removal-v2";

const baseRemember = `        const state = (all[clientId] ??= { projects: [] });
        state.lastCwd = cwd;
        const now = Date.now();`;
const v1Remember = `        const state = (all[clientId] ??= { projects: [] });
        // ${v1Marker}: 全局永久名单优先于「重新打开就取消墓碑」的默认行为。
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
const nextRemember = `        const state = (all[clientId] ??= { projects: [] });
        // ${marker}: 被用户删除的项目即使重新打开，也只作为当前工作目录使用，
        // 不得重新写入最近项目。全局名单让新浏览器 clientId 同样遵守删除决定。
        const globalRemoved = new Set(all.__piweb_global__?.permanentRemovedProjects ?? []);
        const localRemoved = new Set(state.removedProjects ?? []);
        if (globalRemoved.has(cwd) || localRemoved.has(cwd)) {
            state.lastCwd = cwd;
            state.projects = state.projects.filter((p) => p.path !== cwd);
            this.save();
            return;
        }
        state.lastCwd = cwd;
        const now = Date.now();`;

const baseRemove = `        const removed = new Set(state.removedProjects ?? []);
        removed.add(cwd);
        state.removedProjects = [...removed];
        this.save();`;
const nextRemove = `        const removed = new Set(state.removedProjects ?? []);
        removed.add(cwd);
        state.removedProjects = [...removed];
        // ${marker}: UI 的删除决定写入全局名单，而非只影响当前浏览器 clientId。
        const globalState = (all.__piweb_global__ ??= {});
        const globalRemoved = new Set(globalState.permanentRemovedProjects ?? []);
        globalRemoved.add(cwd);
        globalState.permanentRemovedProjects = [...globalRemoved];
        this.save();`;

const baseGetRemoved = `    getRemovedProjects(clientId) {
        return this.load()[clientId]?.removedProjects ?? [];
    }`;
const v1GetRemoved = `    getRemovedProjects(clientId) {
        const all = this.load();
        // ${v1Marker}: 全局名单适用于新旧所有浏览器 clientId，不能只放在单个 client state 里。
        const removed = new Set(all[clientId]?.removedProjects ?? []);
        for (const cwd of all.__piweb_global__?.permanentRemovedProjects ?? []) removed.add(cwd);
        return [...removed];
    }`;
const nextGetRemoved = `    getRemovedProjects(clientId) {
        const all = this.load();
        // ${marker}: 合并该浏览器与全局删除名单，历史 session 扫描也会使用这个结果。
        const removed = new Set(all[clientId]?.removedProjects ?? []);
        for (const cwd of all.__piweb_global__?.permanentRemovedProjects ?? []) removed.add(cwd);
        return [...removed];
    }`;

const baseCurrent = `    withCurrentCwd(projects, now) {
        if (projects.some((p) => p.path === this.cwd)) {`;
const v1Current = `    withCurrentCwd(projects, now) {
        // ${v1Marker}: 用户明确隐藏的项目即使正是当前 cwd，也不得被无条件重新加入最近项目。
        if (this.stateStore.getRemovedProjects(this.clientId).includes(this.cwd)) return projects;
        if (projects.some((p) => p.path === this.cwd)) {`;
const nextCurrent = `    withCurrentCwd(projects, now) {
        // ${marker}: 当前 cwd 也必须尊重用户的删除决定，不能无条件“复活”。
        if (this.stateStore.getRemovedProjects(this.clientId).includes(this.cwd)) return projects;
        if (projects.some((p) => p.path === this.cwd)) {`;

function replaceOne(source, choices, replacement, label) {
    for (const needle of choices) {
        if (source.includes(needle)) return source.replace(needle, replacement);
    }
    throw new Error(`版本锚点不匹配：${label}`);
}

try {
    if (!clientStateFile || !agentServiceFile || !fs.existsSync(clientStateFile) || !fs.existsSync(agentServiceFile)) {
        throw new Error("找不到 pi-web-ui 的 client-state.js 或 agent-service.js");
    }
    let client = fs.readFileSync(clientStateFile, "utf8");
    let agent = fs.readFileSync(agentServiceFile, "utf8");
    if (client.includes(marker) && agent.includes(marker)) {
        console.log("✓ 持久最近项目删除补丁已存在");
        process.exit(0);
    }
    client = replaceOne(client, [v1Remember, baseRemember], nextRemember, "ClientStateStore.remember");
    client = replaceOne(client, [baseRemove], nextRemove, "ClientStateStore.removeProject");
    client = replaceOne(client, [v1GetRemoved, baseGetRemoved], nextGetRemoved, "ClientStateStore.getRemovedProjects");
    agent = replaceOne(agent, [v1Current, baseCurrent], nextCurrent, "AgentService.withCurrentCwd");
    fs.writeFileSync(clientStateFile, client, "utf8");
    fs.writeFileSync(agentServiceFile, agent, "utf8");
    console.log("✓ 已应用持久最近项目删除补丁（用户删除即全局隐藏）");
} catch (err) {
    console.error("✗ " + err.message);
    process.exit(2);
}
