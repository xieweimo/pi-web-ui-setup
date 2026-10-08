#!/usr/bin/env node
/** 验证已安装插件确实被运行中服务读取并随 plugins 清单发布。 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : "8787");
const wsPath = join(process.env.APPDATA || "", "npm", "node_modules", "pi-web-ui", "node_modules", "ws");
assert.ok(existsSync(wsPath), "找不到 pi-web-ui 随附的 ws 模块");
const WebSocket = require(wsPath);

const expected = [
	"host:browser",
	"host:sound",
	"host:language",
	"host:theme",
	"host:update",
	"host:github",
];
const clientId = `piwork-layout-test-${process.pid}-${Date.now()}`;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const timer = setTimeout(() => fail(new Error("等待 plugins 清单超时")), 15_000);
let settled = false;

function fail(error) {
	if (settled) return;
	settled = true;
	clearTimeout(timer);
	try { ws.close(); } catch {}
	console.error(`✗ ${error.message}`);
	process.exit(1);
}

ws.on("error", fail);
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId, locale: "zh" })));
ws.on("message", (raw) => {
	if (settled) return;
	try {
		const message = JSON.parse(raw.toString());
		if (message.type !== "plugins") return;
		const plugin = message.plugins?.find((item) => item.id === "piwork-ui-layout");
		assert.ok(plugin, "运行中服务未发布 piwork-ui-layout 插件");
		assert.deepEqual(plugin.ui?.arrange?.map((item) => item.id), expected);
		for (const item of plugin.ui.arrange) {
			assert.equal(item.hide, false, `${item.id} 未显式显示`);
			assert.equal(item.align, "end", `${item.id} 对齐组不正确`);
		}
		settled = true;
		clearTimeout(timer);
		ws.close();
		console.log("✓ 运行中服务已发布 piwork-ui-layout 的 6 条 ui.arrange 声明");
	} catch (error) {
		fail(error);
	}
});
