#!/usr/bin/env node
/** pi-web-ui 0.99.0：伪客户端的空 sink 不能冒充能应答 page_request 的浏览器。 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");
const targetArg = process.argv.indexOf("--target-dir");
const server = targetArg < 0 ? locateWebUiFile("dist", "server") : path.resolve(process.argv[targetArg + 1] || "");
const file = server && path.join(server, "agent-service.js");
const daemonFile = server && path.join(server, "agent-service-daemon.js");
if (!file || !fs.existsSync(file)) {
	console.error("✗ 找不到 pi-web-ui dist/server/agent-service.js");
	process.exit(2);
}
const marker = "piwork-page-call-browser-sinks-v1";
let source = fs.readFileSync(file, "utf8");
if (source.includes(marker)) {
	if (daemonFile && fs.existsSync(daemonFile) && fs.readFileSync(daemonFile, "utf8").includes("cs.attachSink(send);")) {
		console.error("✗ page-picker 补丁仅在 agent-service.js 落地，daemon 连接仍未过滤伪客户端");
		process.exit(2);
	}
	console.log(`✓ page-picker 浏览器 sink 补丁已落地（${marker}）`);
	process.exit(0);
}
function replaceOnce(before, after) {
	if (source.split(before).length !== 2) throw new Error(`锚点未唯一命中：${before.slice(0, 90)}`);
	source = source.replace(before, after);
}
try {
	replaceOnce("    sinks = new Set();\n    pendingNotices = [];", `    sinks = new Set();\n    browserSinks = new Set(); /* ${marker} */\n    pendingNotices = [];`);
	replaceOnce("    attachSink(send) {\n        this.sinks.add(send);", "    attachSink(send, browserSocket = true) {\n        this.sinks.add(send);\n        if (browserSocket) this.browserSinks.add(send);");
	replaceOnce("    detachSink(send) {\n        this.sinks.delete(send);", "    detachSink(send) {\n        this.sinks.delete(send);\n        this.browserSinks.delete(send);");
	replaceOnce("            if (this.sinks.size === 0) {\n                resolve({", "            if (this.browserSinks.size === 0) {\n                resolve({");
	replaceOnce('            this.emit({ type: "page_request", id, op: req.op, args: req.args, target: req.target, timeoutMs });', '            const message = { type: "page_request", id, op: req.op, args: req.args, target: req.target, timeoutMs };\n            for (const sink of [...this.browserSinks]) sink(message);');
	const attachVariants = [
		"        cs.attachSink(send);\n        // Forward hooks",
		"            cs.attachSink(send);\n            // 又有浏览器连上：离线行状态作废（别的页面按在线行重推，去掉离线标记）。",
	];
	const attachNeedle = attachVariants.find((needle) => source.split(needle).length === 2);
	let daemonSource = null;
	let originalDaemon = null;
	if (attachNeedle) {
		const indent = attachNeedle.startsWith("            ") ? "            " : "        ";
		source = source.replace(attachNeedle, attachNeedle.replace(`${indent}cs.attachSink(send);`, `${indent}cs.attachSink(send, !AgentService.isPseudoClientId(clientId));`));
	} else if (daemonFile && fs.existsSync(daemonFile)) {
		// 0.104.4 将 AgentService 拆分到 daemon，连接挂载随之移入新文件。
		originalDaemon = fs.readFileSync(daemonFile, "utf8");
		const before = "            cs.attachSink(send);\n            // 又有浏览器连上";
		if (originalDaemon.split(before).length !== 2) throw new Error("agent-service-daemon.js 锚点未唯一命中：cs.attachSink(send)");
		daemonSource = originalDaemon.replace(before, "            cs.attachSink(send, !AgentService.isPseudoClientId(clientId));\n            // 又有浏览器连上");
	} else throw new Error("锚点未唯一命中：cs.attachSink(send) 浏览器连接");
	const original = fs.readFileSync(file, "utf8");
	try {
		if (daemonSource !== null) fs.writeFileSync(daemonFile, daemonSource, "utf8");
		fs.writeFileSync(file, source, "utf8");
	} catch (writeError) {
		fs.writeFileSync(file, original, "utf8");
		if (daemonSource !== null) fs.writeFileSync(daemonFile, originalDaemon, "utf8");
		throw writeError;
	}
	console.log(`✓ page-picker 浏览器 sink 补丁已落地（${marker}）`);
} catch (err) {
	console.error(`✗ page-picker 浏览器 sink 补丁失败：${err.message}`);
	process.exit(2);
}
