#!/usr/bin/env node
/**
 * pi-web-ui 0.99.0：发送前影子快照最多占用 750ms；超时取消 Git 子进程，消息照常入列。
 * 源码位置：projects/pi-web-ui-source/server/{agent-service,workspace-snapshot,scm}.ts
 * 默认目标是当前安装的 dist/server；--target-dir DIR 仅用于隔离测试。
 * 锚点必须恰好命中一次，已完整落地时幂等退出；半落地或上游变化时拒绝写入。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "piwork-prompt-snapshot-budget-v1";
const cleanupMarker = "piwork-prompt-snapshot-lock-cleanup-v2";
const retryMarker = "piwork-prompt-snapshot-lock-retry-v3";
const arg = process.argv.indexOf("--target-dir");
const server = arg >= 0 ? path.resolve(process.argv[arg + 1] || "") : locateWebUiFile("dist", "server");
if (!server || !fs.existsSync(server)) {
	console.error("✗ 找不到 pi-web-ui dist/server");
	process.exit(2);
}
const files = ["agent-service.js", "workspace-snapshot.js", "scm.js"];
const originals = new Map();
for (const name of files) {
	const file = path.join(server, name);
	if (!fs.existsSync(file)) {
		console.error(`✗ 缺少目标文件：${file}`);
		process.exit(2);
	}
	originals.set(name, fs.readFileSync(file, "utf8"));
}
const marked = files.filter((name) => originals.get(name).includes(marker));
if (marked.length === files.length) {
	const file = path.join(server, "workspace-snapshot.js");
	const source = originals.get("workspace-snapshot.js");
	if (!source.includes(cleanupMarker) || !source.includes(retryMarker)) {
		try {
			const withLock = source.includes(cleanupMarker) ? source : replaceOnce(source, "await rm(tempIndex, { force: true });", `await rm(tempIndex, { force: true });\n            await rm(\`\${tempIndex}.lock\`, { force: true }); /* ${cleanupMarker} */`, "workspace-snapshot.js");
			const upgraded = withLock.includes(retryMarker) ? withLock : addRetryCleanup(withLock);
			fs.writeFileSync(file, upgraded, "utf8");
			console.log(`✓ 发送前快照限时补丁已升级锁清理（${retryMarker}）`);
		} catch (err) {
			console.error(`✗ 锁清理升级失败：${err.message}`);
			process.exit(2);
		}
	} else {
		console.log(`✓ 发送前快照限时补丁已落地（${marker}、${retryMarker}）`);
	}
	process.exit(0);
}
if (marked.length) {
	console.error(`✗ 补丁仅部分落地：${marked.join(", ")}；拒绝覆盖，请核查文件`);
	process.exit(2);
}
function replaceOnce(source, before, after, name) {
	if (source.split(before).length !== 2) throw new Error(`${name} 锚点未唯一命中：${before.slice(0, 80)}`);
	return source.replace(before, after);
}
function addRetryCleanup(source) {
	const anchor = "        catch {\n            // ignore cleanup error\n        }\n    }\n}";
	const block = `        catch {\n            // ignore cleanup error\n        }\n        if (signal?.aborted) {\n            // Windows 上取消的 Git 子进程可能晚于 finally 创建锁；只重扫本次 UUID 路径。\n            for (const delay of [1000, 3000, 10000]) {\n                const timer = setTimeout(() => {\n                    void Promise.allSettled([rm(tempIndex, { force: true }), rm(\`\${tempIndex}.lock\`, { force: true })]);\n                }, delay);\n                timer.unref();\n            }\n        } /* ${retryMarker} */\n    }\n}`;
	return replaceOnce(source, anchor, block, "workspace-snapshot.js");
}
try {
	let agent = originals.get("agent-service.js");
	agent = replaceOnce(agent, "snapshotRef = await createWorkspaceSnapshot(conv.cwd);", `snapshotRef = await createWorkspaceSnapshot(conv.cwd, AbortSignal.timeout(750)); /* ${marker} */`, "agent-service.js");

	let snapshot = originals.get("workspace-snapshot.js");
	snapshot = replaceOnce(snapshot, "async function runGit(cwd, args, envExtra) {", `async function runGit(cwd, args, envExtra, signal) { /* ${marker} */`, "workspace-snapshot.js");
	snapshot = replaceOnce(snapshot, "env: envExtra ? { ...process.env, ...envExtra } : process.env,\n        timeout: GIT_SNAPSHOT_TIMEOUT_MS,", "env: envExtra ? { ...process.env, ...envExtra } : process.env,\n        signal,\n        timeout: GIT_SNAPSHOT_TIMEOUT_MS,", "workspace-snapshot.js");
	snapshot = replaceOnce(snapshot, "export async function createWorkspaceSnapshot(cwd) {\n    const gitDir = await gitDirOf(cwd);\n    if (!gitDir)", "export async function createWorkspaceSnapshot(cwd, signal) {\n    if (signal?.aborted) return null;\n    const gitDir = await gitDirOf(cwd, signal);\n    if (!gitDir || signal?.aborted)", "workspace-snapshot.js");
	for (const [before, after] of [
		['await runGit(cwd, ["add", "-A"], env);', 'await runGit(cwd, ["add", "-A"], env, signal);'],
		['const tree = await runGit(cwd, ["write-tree"], env);', 'const tree = await runGit(cwd, ["write-tree"], env, signal);'],
		['await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);', 'await runGit(cwd, ["rev-parse", "--verify", "HEAD"], undefined, signal);'],
		['const commitHash = await runGit(cwd, commitArgs, env);', 'const commitHash = await runGit(cwd, commitArgs, env, signal);'],
		['console.warn(`[workspace-snapshot] 创建快照失败 (${cwd}):`, err.message);', 'if (!signal?.aborted) console.warn(`[workspace-snapshot] 创建快照失败 (${cwd}):`, err.message);'],
	]) snapshot = replaceOnce(snapshot, before, after, "workspace-snapshot.js");

	let scm = originals.get("scm.js");
	scm = replaceOnce(scm, "export async function gitDirOf(cwd) {", `export async function gitDirOf(cwd, signal) { /* ${marker} */`, "scm.js");
	scm = replaceOnce(scm, 'timeout: 5_000,\n            windowsHide: true,', 'timeout: 5_000,\n            signal,\n            windowsHide: true,', "scm.js");
	snapshot = replaceOnce(snapshot, "await rm(tempIndex, { force: true });", `await rm(tempIndex, { force: true });\n            await rm(\`\${tempIndex}.lock\`, { force: true }); /* ${cleanupMarker} */`, "workspace-snapshot.js");
	snapshot = addRetryCleanup(snapshot);
	const updated = new Map([["agent-service.js", agent], ["workspace-snapshot.js", snapshot], ["scm.js", scm]]);
	// 全部锚点预检成功后才写。写入失败回滚已改的文件。
	const written = [];
	try {
		for (const [name, content] of updated) {
			fs.writeFileSync(path.join(server, name), content, "utf8");
			written.push(name);
		}
	} catch (err) {
		for (const name of written.reverse()) fs.writeFileSync(path.join(server, name), originals.get(name), "utf8");
		throw err;
	}
	console.log(`✓ 发送前快照限时补丁已落地（${marker}）`);
} catch (err) {
	console.error(`✗ 发送前快照限时补丁失败：${err.message}`);
	process.exit(2);
}
