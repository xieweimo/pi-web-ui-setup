#!/usr/bin/env node
/**
 * 最近项目的用户操作语义：删除与主动打开都必须生效。
 *
 * - UI「删除」：写入全局 removedProjects，历史 session 扫描不会自动复活项目。
 * - UI「打开项目」/以该 cwd 启动：remember() 清除删除标记，项目重新回到最近项目。
 *
 * 不包含任何硬编码路径。全局名单让删除能跨 browser clientId 保存；主动打开则是
 * 明确的恢复动作。兼容早期错误使用的 permanentRemovedProjects，打开时一并清掉。
 */
const fs = require("fs");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");
const target = locateWebUiFile("dist", "server", "client-state.js");
const marker = "managed-recent-project-actions-v3";
const baseRemember = `        const state = (all[clientId] ??= { projects: [] });
        state.lastCwd = cwd;
        const now = Date.now();`;
const nextRemember = `        const state = (all[clientId] ??= { projects: [] });
        // ${marker}: 主动打开 cwd 是用户明确的恢复操作，清除本 client 与全局删除记录。
        if (state.removedProjects?.length) state.removedProjects = state.removedProjects.filter((p) => p !== cwd);
        const globalState = all.__piweb_global__;
        if (globalState?.removedProjects?.length) globalState.removedProjects = globalState.removedProjects.filter((p) => p !== cwd);
        // 清理上一版错误的永久名单；它仅是旧实现遗留，不再参与正常逻辑。
        if (globalState?.permanentRemovedProjects?.length) globalState.permanentRemovedProjects = globalState.permanentRemovedProjects.filter((p) => p !== cwd);
        state.lastCwd = cwd;
        const now = Date.now();`;
const baseRemove = `        const removed = new Set(state.removedProjects ?? []);
        removed.add(cwd);
        state.removedProjects = [...removed];
        this.save();`;
const nextRemove = `        const removed = new Set(state.removedProjects ?? []);
        removed.add(cwd);
        state.removedProjects = [...removed];
        // ${marker}: 删除适用于所有浏览器 clientId，session 扫描也会读此名单。
        const globalState = (all.__piweb_global__ ??= {});
        const globalRemoved = new Set(globalState.removedProjects ?? []);
        globalRemoved.add(cwd);
        globalState.removedProjects = [...globalRemoved];
        this.save();`;
const baseGetRemoved = `    getRemovedProjects(clientId) {
        return this.load()[clientId]?.removedProjects ?? [];
    }`;
const nextGetRemoved = `    getRemovedProjects(clientId) {
        const all = this.load();
        // ${marker}: 合并本 client 与全局用户删除名单，阻止旧 session 自动复活。
        const removed = new Set(all[clientId]?.removedProjects ?? []);
        for (const cwd of all.__piweb_global__?.removedProjects ?? []) removed.add(cwd);
        // 兼容旧版误写的名单；在用户主动打开该项目时 remember() 会移除它。
        for (const cwd of all.__piweb_global__?.permanentRemovedProjects ?? []) removed.add(cwd);
        return [...removed];
    }`;
function one(source, needle, replacement, label) {
    const n = source.split(needle).length - 1;
    if (n !== 1) throw new Error(`${label} 锚点命中 ${n} 次`);
    return source.replace(needle, replacement);
}
if (!target || !fs.existsSync(target)) { console.error("✗ 找不到 client-state.js"); process.exit(2); }
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) { console.log("✓ 最近项目用户操作补丁已存在"); process.exit(0); }
// 自 0.94.1 起上游自己实现了同样（甚至更彻底）的语义：removeProject 写 removedProjects，
// getRemovedProjects 合并全局名单，remember() 遍历所有 client 清除 tombstone。
// 因此本补丁退役：探测到上游实现即视为成功，不再改动产物。
if (source.includes("clears its removal tombstone")) {
	console.log("✓ 上游已内建最近项目删除/恢复语义，本补丁自 0.94.1 起退役（无需再打）");
	process.exit(0);
}
try {
    source = one(source, baseRemember, nextRemember, "remember");
    source = one(source, baseRemove, nextRemove, "removeProject");
    source = one(source, baseGetRemoved, nextGetRemoved, "getRemovedProjects");
    fs.writeFileSync(target, source, "utf8");
    console.log("✓ 已应用最近项目用户操作补丁");
} catch (err) { console.error("✗ " + err.message); process.exit(2); }
