#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const expected = [
	["host:browser", 41, "tools"],
	["host:sound", 70, "system"],
	["host:language", 80, "system"],
	["host:theme", 82, "system"],
	["host:update", 90, "system"],
	["host:github", 200, "system"],
];

assert.equal(manifest.id, "piwork-ui-layout");
assert.equal(manifest.apiVersion, 2);
assert.equal(manifest.view, false, "纯布局插件不得创建空白视图 tab");
assert.deepEqual(manifest.permissions, ["ui"]);
assert.ok(Array.isArray(manifest.ui?.arrange));
assert.equal(manifest.ui.arrange.length, expected.length);

for (const [id, order, group] of expected) {
	const op = manifest.ui.arrange.find((item) => item.id === id);
	assert.deepEqual(op, { id, hide: false, group, order, align: "end" });
}

console.log("✓ piwork-ui-layout manifest 合法：仅使用 ui.arrange，未声明客户端 DOM 或服务端能力");
