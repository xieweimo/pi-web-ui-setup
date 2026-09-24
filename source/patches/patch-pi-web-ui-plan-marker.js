#!/usr/bin/env node
/**
 * 为 pi-web-ui 内联标记系统增加 [[plan:...]]，让回答正文可自动驱动 Plan Mode，
 * 不再依赖模型额外调用 plan_update 工具。
 *
 * 语法：
 *   [[plan:new:1=调研,2=实现,3=验证,active=1]]
 *   [[plan:set:1=done,2=in_progress,active=2]]
 *   [[plan:active:2]]
 *   [[plan:clear:now]]
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "plan-inline-marker-v2";
const snapshotMarker = "plan-marker-snapshot-v2";
const restoreMarker = "plan-marker-restore-v2";
const server = locateWebUiFile("dist", "server");
if (!server || !fs.existsSync(server)) {
	console.error("✗ 找不到 pi-web-ui 的 dist/server");
	process.exit(1);
}
const builtins = path.join(server, "markers", "builtins");
const planFile = path.join(builtins, "plan.js");
const indexFile = path.join(server, "markers", "index.js");
const serviceFile = path.join(server, "marker-service.js");
const agentFile = path.join(server, "agent-service.js");
const assets = locateWebUiFile("web", "dist", "assets");
const bundle = assets && fs.existsSync(assets)
	? path.join(assets, fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name)) || "")
	: null;

const planSource = `/** ${marker} — Plan Mode 的内联标记。 */
import { pick } from "../../i18n.js";
export const PLAN_NAMESPACE = "plan";
const STATUSES = new Set(["pending", "in_progress", "done", "failed"]);
const guidanceZh = [
	"# 任务看板内联标记（状态变化直接写在回答正文，无需调用 plan_update）",
	"- [[plan:new:1=调研,2=实现,3=验证,active=1]] 新建/覆盖看板；步骤格式为 id=标题。",
	"- [[plan:set:1=done,2=in_progress,active=2]] 更新步骤状态；状态仅能为 pending / in_progress / done / failed。",
	"- [[plan:active:2]] 仅切换当前活动步骤；[[plan:clear:now]] 清空看板。",
	"- 每完成、失败、阻塞或切换步骤时都必须写对应标记；最终全部完成后不要设置 active。",
];
const guidanceEn = [
	"# Plan board inline markers (write state changes in the reply body; do not call plan_update)",
	"- [[plan:new:1=Research,2=Implement,3=Verify,active=1]] creates/replaces the board.",
	"- [[plan:set:1=done,2=in_progress,active=2]] changes statuses; valid values are pending / in_progress / done / failed.",
	"- [[plan:active:2]] changes only the active step; [[plan:clear:now]] clears the board.",
	"- Write a marker whenever a step changes; omit active after all work finishes.",
];
function fail(lang, text, textEn) { return { applied: false, error: pick(lang, text, textEn) }; }
function emitPlan(ctx, steps, activeStepId, state) {
	const host = ctx.host;
	const manager = host?.planManager;
	if (!manager || typeof manager.setPlan !== "function") return null;
	const plan = manager.setPlan(ctx.conversationId, steps, activeStepId);
	// 把状态写回 marker 快照：PlanManager 只在内存里，重启后靠它回填。
	if (state) {
		state.steps = plan.steps.map((step) => ({ ...step }));
		state.activeStepId = plan.activeStepId;
	}
	host.emit?.({ type: "plan_updated", conversationId: ctx.conversationId, plan });
	host.flushSnapshot?.();
	return plan;
}
function splitStep(raw, fallbackId) {
	const text = String(raw ?? "").trim();
	const eq = text.indexOf("=");
	if (eq > 0) return { id: text.slice(0, eq).trim(), title: text.slice(eq + 1).trim() };
	return { id: String(fallbackId), title: text };
}
export const planMarker = {
	name: PLAN_NAMESPACE,
	getGuidance(lang) { return lang === "zh" ? guidanceZh : guidanceEn; },
	init() { return {}; },
	apply(token, ctx, state, lang) {
		const manager = ctx.host?.planManager;
		if (!manager) return fail(lang, "任务看板服务不可用", "Plan board service is unavailable");
		// PlanManager 只活在内存里：服务重启后计划会丢，所以先用会话快照回填，
		// 再把每次变更写回快照。/*plan-marker-snapshot-v2*/
		let current = manager.getPlan?.(ctx.conversationId) ?? null;
		if (!current && Array.isArray(state?.steps) && state.steps.length) {
			current = emitPlan(ctx, state.steps, state.activeStepId ?? null, state);
		}
		if (token.op === "clear") { emitPlan(ctx, [], undefined, state); return { applied: true }; }
		if (token.op === "new") {
			if (!token.args.length) return fail(lang, "plan:new 至少需要一个步骤", "plan:new needs at least one step");
			const steps = token.args.map((raw, index) => {
				const step = splitStep(raw, index + 1);
				return { ...step, status: "pending" };
			});
			const active = token.kwargs.active || undefined;
			if (active) {
				const hit = steps.find((step) => step.id === active);
				if (hit) hit.status = "in_progress";
			}
			emitPlan(ctx, steps, active, state);
			return { applied: true };
		}
		if (token.op === "active") {
			const active = String(token.args[0] ?? "").trim();
			if (!current || !active) return fail(lang, "没有可切换的任务看板步骤", "No plan step is available to activate");
			const steps = current.steps.map((step) => ({ ...step, status: step.id === active ? "in_progress" : step.status }));
			if (!steps.some((step) => step.id === active)) return fail(lang, "找不到步骤 " + active, "Step " + active + " was not found");
			emitPlan(ctx, steps, active, state);
			return { applied: true };
		}
		if (token.op === "set") {
			if (!current) return fail(lang, "请先用 plan:new 新建看板", "Create a board with plan:new first");
			const updates = new Map();
			for (const raw of token.args) {
				const step = splitStep(raw, "");
				if (!step.id || !STATUSES.has(step.title)) return fail(lang, "无效状态：" + raw, "Invalid step status: " + raw);
				updates.set(step.id, step.title);
			}
			if (!updates.size) return fail(lang, "plan:set 至少需要一个 id=状态", "plan:set needs at least one id=status pair");
			const missing = [...updates.keys()].find((id) => !current.steps.some((step) => step.id === id));
			if (missing) return fail(lang, "找不到步骤 " + missing, "Step " + missing + " was not found");
			const steps = current.steps.map((step) => updates.has(step.id) ? { ...step, status: updates.get(step.id) } : { ...step });
			const active = token.kwargs.active !== undefined ? token.kwargs.active : undefined;
			if (active && !steps.some((step) => step.id === active)) return fail(lang, "找不到活动步骤 " + active, "Active step " + active + " was not found");
			emitPlan(ctx, steps, active, state);
			return { applied: true };
		}
		return fail(lang, "未知 plan 操作：" + token.op, "Unknown plan operation: " + token.op);
	},
};
`;

function replaceOne(file, needle, replacement, label) {
	let text = fs.readFileSync(file, "utf8");
	if (text.includes(replacement)) return false;
	const count = text.split(needle).length - 1;
	if (count !== 1) throw new Error(`${label} 锚点命中 ${count} 次`);
	fs.writeFileSync(file, text.replace(needle, replacement), "utf8");
	return true;
}
try {
	fs.mkdirSync(builtins, { recursive: true });
	if (!fs.existsSync(planFile) || !fs.readFileSync(planFile, "utf8").includes(marker)) {
		fs.writeFileSync(planFile, planSource, "utf8");
	}
	replaceOne(indexFile, 'import { renameMarker } from "./builtins/rename.js";', 'import { renameMarker } from "./builtins/rename.js";\nimport { planMarker } from "./builtins/plan.js";', "marker import");
	replaceOne(indexFile, "registerMarker(renameMarker);", "registerMarker(renameMarker);\n    registerMarker(planMarker);", "marker registration");
	replaceOne(indexFile, "export { todoMarker, notifyMarker, renameMarker };", "export { todoMarker, notifyMarker, renameMarker, planMarker };", "marker export");
	replaceOne(serviceFile, "const ctx = {\n                conversationId,\n                notify: (msg, level, msgEn) => {", "const ctx = {\n                conversationId,\n                host: this.host,\n                notify: (msg, level, msgEn) => {", "marker context");
	replaceOne(
		serviceFile,
		`        const getOrInit = (ns) => {
            let st = states.get(ns);
            if (st !== undefined)
                return st;
            if (ns === TODO_NAMESPACE)
                st = this.getState(conversationId, ns, initTodoState);
            else {
                const marker = getMarker(ns);
                st = marker?.init ? marker.init() : {};
            }
            states.set(ns, st);
            return st;
        };`,
		`        const getOrInit = (ns) => {
            let st = states.get(ns);
            if (st !== undefined)
                return st;
            // ${snapshotMarker}：先读会话快照（服务重启后靠它回填），再回落 marker.init()。
            const marker = getMarker(ns);
            st = this.getState(conversationId, ns, () => (ns === TODO_NAMESPACE ? initTodoState() : marker?.init ? marker.init() : {}));
            states.set(ns, st);
            return st;
        };`,
		"marker snapshot load",
	);
	// plan marker 需要真实 AgentService 的 PlanManager；此前只给 marker-service
	// 的 ctx 注入 host，却遗漏了构造 MarkerService 时传入该字段，导致运行时必报
	// “Plan board service is unavailable”。
	replaceOne(
		agentFile,
		`        this.markerSvc = new MarkerService({
            clientId,
            stateStore,
            emit: (msg) => this.emit(msg),`,
		`        this.markerSvc = new MarkerService({
            clientId,
            stateStore,
            planManager: this.planManager,
            flushSnapshot: () => this.flushSnapshot(),
            emit: (msg) => this.emit(msg),`,
		"plan marker host",
	);
	// 页面加载/下发状态时也要能自动回填：否则重启后看板要等到下次写标记才回来。
	replaceOne(
		agentFile,
		`    /** 任务计划管理器（Plan Mode / Step State Machine）。 */
    planManager = new PlanManager();`,
		`    /** 任务计划管理器（Plan Mode / Step State Machine）。 */
    planManager = new PlanManager();
    /** ${restoreMarker}：PlanManager 只在内存里，服务重启后从会话快照回填看板。 */
    restorePlanFromSnapshot(convId) {
        if (!convId) return null;
        const snap = this.markerSvc?.getRawState?.(convId, "plan");
        if (!snap || !Array.isArray(snap.steps) || snap.steps.length === 0) return null;
        return this.planManager.setPlan(convId, snap.steps, snap.activeStepId ?? undefined);
    }`,
		"plan restore helper",
	);
	replaceOne(
		agentFile,
		`            plan: this.planManager.getPlan(this.activeId),`,
		`            plan: this.planManager.getPlan(this.activeId) ?? this.restorePlanFromSnapshot(this.activeId), /*${restoreMarker}*/`,
		"plan restore on snapshot",
	);
	if (!bundle || !fs.existsSync(bundle)) throw new Error("找不到 web bundle");
	let web = fs.readFileSync(bundle, "utf8");
	const webNeedle = "markerGroupRename:`重命名标记 conv/rename`";
	const webReplacement = "markerGroupRename:`重命名标记 conv/rename`,markerGroupPlan:`任务看板标记 plan`/*plan-inline-marker-v1*/";
	if (!web.includes(marker)) {
		const count = web.split(webNeedle).length - 1;
		if (count !== 1) throw new Error(`markerGroupPlan 锚点命中 ${count} 次`);
		fs.writeFileSync(bundle, web.replace(webNeedle, webReplacement), "utf8");
	}
	console.log("✓ 已安装 [[plan:...]] 自动任务看板标记");
} catch (error) {
	console.error(`✗ plan 内联标记补丁失败：${error.message}`);
	process.exit(2);
}
