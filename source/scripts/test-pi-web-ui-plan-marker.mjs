#!/usr/bin/env node
/** [[plan:...]] 补丁的服务端全链路 mock 测试。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { MarkerService } from "file:///C:/Users/X/AppData/Roaming/npm/node_modules/pi-web-ui/dist/server/marker-service.js";
import { PlanManager } from "file:///C:/Users/X/AppData/Roaming/npm/node_modules/pi-web-ui/dist/server/plan-manager.js";

const emitted = [];
const settings = { markersEnabled: true, disabledMarkers: [] };
const host = {
	clientId: "test",
	stateStore: {
		getMarkerSettings: () => ({ ...settings }),
		saveMarkerSettings: () => {},
	},
	planManager: new PlanManager(),
	getSessionManager: () => null,
	lang: () => "zh",
	emit: (message) => emitted.push(message),
	refreshMarkers: () => {},
	renameConversation: () => {},
	flushSnapshot: () => {},
};
const markers = new MarkerService(host);

// 防回归：mock 给 host 注入 planManager 不能证明真实 AgentService 也做了这件事。
const agentService = await fs.readFile(
	"C:/Users/X/AppData/Roaming/npm/node_modules/pi-web-ui/dist/server/agent-service.js",
	"utf8",
);
assert.match(
	agentService,
	/this\.markerSvc = new MarkerService\(\{[\s\S]*?planManager: this\.planManager,[\s\S]*?flushSnapshot: \(\) => this\.flushSnapshot\(\),/,
	"AgentService 必须把 planManager 与 flushSnapshot 注入 MarkerService host",
);

await markers.handleAssistantText("conv", "[[plan:new:1=调研,2=实现,3=验证,active=1]]");
let plan = host.planManager.getPlan("conv");
assert.deepEqual(plan.steps.map((s) => [s.id, s.title, s.status]), [
	["1", "调研", "in_progress"],
	["2", "实现", "pending"],
	["3", "验证", "pending"],
]);
assert.equal(plan.activeStepId, "1");

await markers.handleAssistantText("conv", "[[plan:set:1=done,2=in_progress,active=2]]");
plan = host.planManager.getPlan("conv");
assert.deepEqual(plan.steps.map((s) => s.status), ["done", "in_progress", "pending"]);
assert.equal(plan.activeStepId, "2");

await markers.handleAssistantText("conv", "[[plan:set:2=done,3=done]]");
plan = host.planManager.getPlan("conv");
assert.deepEqual(plan.steps.map((s) => s.status), ["done", "done", "done"]);
assert.equal(plan.activeStepId, null);
assert.equal(emitted.filter((m) => m.type === "plan_updated").length, 3);

await markers.handleAssistantText("conv", "[[plan:clear:now]]");
plan = host.planManager.getPlan("conv");
assert.deepEqual(plan.steps, []);
assert.equal(plan.activeStepId, null);
assert.equal(emitted.filter((m) => m.type === "plan_updated").length, 4);

console.log("✓ [[plan:...]] marker：新建、更新、完成、清空全链路通过");
