#!/usr/bin/env node
/**
 * 隐藏「被 fork 掉的父会话」。
 *
 * pi-web-ui 的「编辑重问 / 重试」通过 fork 实现，每次都会新建一个会话文件并把
 * 上一代路径写进 header 的 parentSession。于是一次长对话可能变成
 * A → B → C → D 四个文件，历史列表里显示成四条同名记录。
 *
 * 本补丁让 pushSessions() 只列出「没有被任何其他会话当作父会话」的文件，
 * 也就是每个对话只显示最新的链尾，历史列表回归「一个对话一条」。
 *
 * 实现方式（0.86.2 起）：直接用 SDK 已经解析好的 info.parentSessionPath
 * （@earendil-works/pi-coding-agent 的 session-manager 里取自 header.parentSession），
 * 不再自己读文件头。老版补丁用 openSync/readSync 读 header，并且依赖当时那句
 * node:fs 导入行 —— 0.86.2 把导入行改成 appendFileSync/…/writeFileSync 后就
 * 静默失效了（源码不匹配 → 退出码 2）。现在只依赖会话列表的字段，版本敏感度更低。
 *
 * 幂等；由启动器在服务启动前执行；源码不匹配时退出码 2 且不阻断服务。
 */
const fs = require("fs");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const target = locateWebUiFile("dist", "server", "agent-service.js");
const marker = "hide-forked-sessions";

// 锚点必须连 `const sessions = new Map();` 与紧跟的循环一起写：0.90.0 起
// `for (const s of infos) {` 在会话搜索里也会出现（搜索必须保留全部会话，不能去重），
// 单独拿循环行当锚点会命中两处。
const listNeedle = `            const infos = await this.loadSessionInfos();
            const sessions = new Map();
            for (const s of infos) {`;
const listReplacement = `            const infos = await this.loadSessionInfos();
            // ${marker}: 只保留 fork 链的链尾。列表里的 info.parentSessionPath 就是
            // header.parentSession（SDK 已解析），只要它指向列表中的某个会话，那个会话
            // 就是被 fork 掉的上一代，不该再单独占一条历史记录。
            const normSessionPath = (p) => String(p).replace(/\\\\/g, "/").replace(/\\/$/, "").toLowerCase();
            const forkedParentPaths = new Set();
            for (const info of infos) {
                if (typeof info.parentSessionPath === "string" && info.parentSessionPath) {
                    forkedParentPaths.add(normSessionPath(info.parentSessionPath));
                }
            }
            const visibleInfos = forkedParentPaths.size > 0
                ? (() => {
                    // 全部被过滤时（例如父会话文件已被删掉）回退为原列表，宁可多显示也不显示空。
                    const kept = infos.filter((info) => !forkedParentPaths.has(normSessionPath(info.path)));
                    return kept.length > 0 ? kept : infos;
                })()
                : infos;
            const sessions = new Map();
            for (const s of visibleInfos) {`;

/** 出现次数必须恰好为 1：两处以上说明锚点太宽（0.90.0 里 searchSessions() 也遍历 infos）。 */
function countOf(source, needle) {
	let n = 0;
	let i = source.indexOf(needle);
	while (i !== -1) {
		n += 1;
		i = source.indexOf(needle, i + needle.length);
	}
	return n;
}

if (!target || !fs.existsSync(target)) {
	console.error("✗ 找不到 pi-web-ui 的 dist/server/agent-service.js");
	process.exit(1);
}
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
	console.log("✓ 隐藏 fork 父会话补丁已存在");
	process.exit(0);
}
if (countOf(source, listNeedle) !== 1) {
	console.error("✗ pi-web-ui 版本的目标代码已变化，未应用 hide-forked-sessions 补丁");
	process.exit(2);
}
source = source.replace(listNeedle, listReplacement);
fs.writeFileSync(target, source, "utf8");
console.log("✓ 已应用 hide-forked-sessions 补丁");
