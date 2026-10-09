#!/usr/bin/env node
/** pi-web-ui 0.99.0：伪客户端的空 sink 不能冒充能应答 page_request 的浏览器。 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");
const targetArg = process.argv.indexOf("--target-dir");
const server = targetArg < 0 ? locateWebUiFile("dist", "server") : path.resolve(process.argv[targetArg + 1] || "");
const file = server && path.join(server, "agent-service.js");
if (!file || !fs.existsSync(file)) {
	console.error("✗ 找不到 pi-web-ui dist/server/agent-service.js");
	process.exit(2);
}
const marker = "piwork-page-call-browser-sinks-v1";
let source = fs.readFileSync(file, "utf8");
if (source.includes(marker)) {
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
	replaceOnce("        cs.attachSink(send);\n        // Forward hooks", "        cs.attachSink(send, !AgentService.isPseudoClientId(clientId));\n        // Forward hooks");
	fs.writeFileSync(file, source, "utf8");
	console.log(`✓ page-picker 浏览器 sink 补丁已落地（${marker}）`);
} catch (err) {
	console.error(`✗ page-picker 浏览器 sink 补丁失败：${err.message}`);
	process.exit(2);
}
