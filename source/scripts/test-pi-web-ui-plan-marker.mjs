#!/usr/bin/env node
/** [[plan:...]] 补丁的服务端全链路 mock 测试。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { MarkerService } from "file:///C:/Users/X/AppData/Roaming/npm/node_modules/pi-web-ui/dist/server/marker-service.js";
import { PlanManager } from "file:///C:/Users/X/AppData/Roaming/npm/node_modules/pi-web-ui/dist/server/plan-manager.js";

const emitted = [];
const settings = { markersEnabled: true, disabledMarkers: [] };

// 模拟 SDK 会话文件：appendCustomEntry 落盘、getBranch 读回，
// 这样「写快照 → 重启后回填」的闭环能真跑一遍，而不是靠 mock 假装成功。
const branch = [];
const sessionManager = {
	appendCustomEntry: (customType, data) => { branch.push({ type: "custom", customType, data }); },
	getBranch: () => branch,
};
const snapshots = () => branch
	.filter((e) => e.customType === "marker-tools/store" && e.data?.namespace === "plan")
	.map((e) => e.data.state);

function makeHost() {
	return {
		clientId: "test",
		stateStore: {
			getMarkerSettings: () => ({ ...settings }),
			saveMarkerSettings: () => {},
		},
		planManager: new PlanManager(),
		getSessionManager: () => sessionManager,
		lang: () => "zh",
		emit: (message) => emitted.push(message),
		refreshMarkers: () => {},
		renameConversation: () => {},
		flushSnapshot: () => {},
	};
}

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

const host = makeHost();
const markers = new MarkerService(host);

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

// 快照必须存真实步骤，而不是空对象（曾把 {} 当状态落盘，重启即丢看板）。
const snaps = snapshots();
assert.ok(snaps.length >= 3, `plan 标记必须落快照，实际 ${snaps.length} 条`);
assert.deepEqual(snaps[snaps.length - 1].steps.map((s) => [s.id, s.status]), [
	["1", "done"],
	["2", "done"],
	["3", "done"],
]);
assert.equal(snaps[snaps.length - 1].activeStepId, null);

// 模拟服务重启：PlanManager 内存清空，只能靠会话快照回填。
const host2 = makeHost();
const markers2 = new MarkerService(host2);
assert.equal(host2.planManager.getPlan("conv"), null);
await markers2.handleAssistantText("conv", "[[plan:set:3=in_progress,active=3]]");
const recovered = host2.planManager.getPlan("conv");
assert.deepEqual(recovered.steps.map((s) => [s.id, s.status]), [
	["1", "done"],
	["2", "done"],
	["3", "in_progress"],
]);
assert.equal(recovered.activeStepId, "3");

// 清空后重启不得复活旧看板。
await markers2.handleAssistantText("conv", "[[plan:clear:now]]");
const host3 = makeHost();
const markers3 = new MarkerService(host3);
await markers3.handleAssistantText("conv", "[[plan:new:1=重来,active=1]]");
assert.deepEqual(host3.planManager.getPlan("conv").steps.map((s) => [s.id, s.title]), [["1", "重来"]]);

// 页面加载时的回填路径：AgentService.restorePlanFromSnapshot 依赖 getRawState 读快照。
assert.match(
	agentService,
	/plan: this\.planManager\.getPlan\(this\.activeId\) \?\? this\.restorePlanFromSnapshot\(this\.activeId\)/,
	"AgentService 下发状态时必须能回填看板",
);
const rawForRestore = markers3.getRawState("conv", "plan");
assert.ok(
	Array.isArray(rawForRestore?.steps) && rawForRestore.steps.length === 1,
	"getRawState 必须能从会话快照读回步骤",
);
const restoredManager = new PlanManager();
restoredManager.setPlan("conv", rawForRestore.steps, rawForRestore.activeStepId ?? undefined);
assert.deepEqual(restoredManager.getPlan("conv").steps.map((s) => [s.id, s.title]), [["1", "重来"]]);

console.log("✓ [[plan:...]] marker：新建、更新、完成、清空、快照持久化与重启恢复全部通过");
