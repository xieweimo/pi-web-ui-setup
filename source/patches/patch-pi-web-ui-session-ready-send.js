#!/usr/bin/env node
/** pi-web-ui 0.99.0：会话 attach 未完成时不开放输入框；同时修复重连时旧快照误判。 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");
const marker = "piwork-session-ready-send-v1";
const transitionMarker = "piwork-session-ready-send-v2";
const root = path.resolve(__dirname, "..");
const dir = process.argv[2] ? path.resolve(process.argv[2]) : locateWebUiFile("web", "dist", "assets");
const bundle = dir && fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => /^index-.*\.js$/.test(n)) : null;
if (!bundle) { console.error("✗ 找不到 pi-web-ui bundle"); process.exit(2); }
const target = path.join(dir, bundle);
const dev = path.join(root, "projects/pi-web-ui-source/web/src/use-chat.ts");
function once(source, from, to, label) {
	if (source.split(from).length !== 2) throw new Error(`${label} 锚点未唯一命中：${from.slice(0, 95)}`);
	return source.replace(from, to);
}
function patchBundle(source) {
	const edits = [
		["status:t.status,ready:t.status===`open`&&e.ready,terminals:", "status:t.status,ready:t.status===`open`&&e.ready,sessionReady:t.status===`open`&&e.sessionReady,terminals:"],
		["return r&&r!==n&&(i=xc(r)),{...e,ready:!0,state:t.state,sessions:i,", "return r&&r!==n&&(i=xc(r)),{...e,ready:!0,sessionReady:!0,state:t.state,sessions:i,"],
		["{...e,ready:!0,state:i,approval:", "{...e,ready:!0,sessionReady:!0,state:i,approval:"],
		["status:`connecting`,ready:!1,state:null,hostMetrics:", "status:`connecting`,ready:!1,sessionReady:!1,state:null,hostMetrics:"],
		["da({ready:e.ready,status:e.status,cwd:", "da({ready:e.ready&&e.sessionReady,status:e.status,cwd:"],
		["},[e.ready,e.status,e.state?.cwd,e.state?.workspaceRoots", "},[e.ready,e.sessionReady,e.status,e.state?.cwd,e.state?.workspaceRoots"],
	];
	for (const [from, to] of edits) source = once(source, from, to, "bundle");
	return once(source, "sessionReady:t.status===`open`&&e.sessionReady,terminals:", `sessionReady:t.status===\`open\`&&e.sessionReady,/*${marker}*/terminals:` , "bundle 标记");
}
function patchBundleTransition(source) {
	source = once(source, "case`host_metrics`:return{...e,hostMetrics:t.metrics};", `case\`session_initializing\`:return{...e,sessionReady:!1};/*${transitionMarker}*/case\`host_metrics\`:return{...e,hostMetrics:t.metrics};`, "bundle 新会话门禁");
	return once(source, "r.send(JSON.stringify(e)),e.type===`question_answer`", "e.type===`new_chat`&&t({type:`session_initializing`}),r.send(JSON.stringify(e)),e.type===`question_answer`", "bundle 发送拦截");
}
function patchDevTransition(source) {
	const crlf = source.includes("\r\n");
	let text = source.replace(/\r\r?\n/g, "\n");
	text = once(text, '| { type: "status"; status: ConnStatus }\n', '| { type: "status"; status: ConnStatus }\n\t| { type: "session_initializing" }\n', "dev action");
	text = once(text, '\t\tcase "host_metrics":\n', `\t\tcase "session_initializing":\n\t\t\treturn { ...state, sessionReady: false }; // ${transitionMarker}\n\t\tcase "host_metrics":\n`, "dev reducer");
	text = once(text, '\t\t\tws.send(JSON.stringify(msg));\n\t\t\t// 提交/取消模型提问后', '\t\t\tif (msg.type === "new_chat") dispatch({ type: "session_initializing" });\n\t\t\tws.send(JSON.stringify(msg));\n\t\t\t// 提交/取消模型提问后', "dev send");
	return crlf ? text.replace(/\n/g, "\r\n") : text;
}
function patchDev(source) {
	const edits = [
		["\tready: boolean;\n\tstate: UiState | null;", `\tready: boolean;\n\t/** ${marker}：当前连接已有会话快照。 */\n\tsessionReady: boolean;\n\tstate: UiState | null;`],
		["ready: action.status === \"open\" ? state.ready : false,", "ready: action.status === \"open\" ? state.ready : false,\n\t\t\t\tsessionReady: action.status === \"open\" ? state.sessionReady : false,"],
		["ready: true,\n\t\t\t\tstate: action.state,", "ready: true,\n\t\t\t\tsessionReady: true,\n\t\t\t\tstate: action.state,"],
		["ready: true,\n\t\t\t\tstate: merged,", "ready: true,\n\t\t\t\tsessionReady: true,\n\t\t\t\tstate: merged,"],
		["ready: false,\n\t\tstate: null,", "ready: false,\n\t\tsessionReady: false,\n\t\tstate: null,"],
		["ready: chat.ready,\n\t\t\tstatus: chat.status,", "ready: chat.ready && chat.sessionReady,\n\t\t\tstatus: chat.status,"],
		["\t\tchat.ready,\n\t\tchat.status,", "\t\tchat.ready,\n\t\tchat.sessionReady,\n\t\tchat.status,"],
	];
	for (const [from, to] of edits) source = once(source, from, to, "dev source");
	return source;
}
try {
	const oldBundle = fs.readFileSync(target, "utf8");
	const oldDev = fs.existsSync(dev) ? fs.readFileSync(dev, "utf8") : null;
	if (oldBundle.includes(transitionMarker) && (oldDev === null || oldDev.includes(transitionMarker))) {
		console.log("✓ 会话就绪发送门禁已落地"); process.exit(0);
	}
	const baseBundle = oldBundle.includes(marker) ? oldBundle : patchBundle(oldBundle);
	const nextBundle = baseBundle.includes(transitionMarker) ? baseBundle : patchBundleTransition(baseBundle);
	const baseDev = oldDev === null ? null : oldDev.includes(marker) ? oldDev : patchDev(oldDev.replace(/\r\r?\n/g, "\n"));
	const nextDev = baseDev === null ? null : baseDev.includes(transitionMarker) ? baseDev : patchDevTransition(baseDev);
	fs.writeFileSync(target, nextBundle, "utf8");
	try {
		if (nextDev !== null) {
			const lineEnding = oldDev.includes("\r\r\n") ? "\r\r\n" : oldDev.includes("\r\n") ? "\r\n" : "\n";
			fs.writeFileSync(dev, nextDev.replace(/\r\r?\n/g, "\n").replace(/\n/g, lineEnding), "utf8");
		}
	}
	catch (err) { fs.writeFileSync(target, oldBundle, "utf8"); throw err; }
	console.log(`✓ 会话就绪发送门禁已落地：${target}`);
} catch (err) { console.error(`✗ 会话就绪发送门禁失败：${err.message}`); process.exit(2); }
