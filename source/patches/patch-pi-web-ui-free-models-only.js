#!/usr/bin/env node
/**
 * pi-web-ui：模型下拉只下发「已验证免费 / 订阅内 / 高性价比白名单」模型。
 *
 * 重要：目录元数据中 cost=0 只代表“标价为零”，不代表当前账号的聊天端点可用。
 * v3 起，免费模型必须同时满足：cost 四项为 0 + 在
 * ~/.pi/agent/model-visibility.json 的 verifiedFreeModels 明确列出。
 * 绿色「免费」徽标也只下发给这个已验证清单，避免把 404、429、超时的条目误标。
 *
 * v3 验证基线（2026-09-29，每个流式 HTTP 200 连测 3 次）：
 * - zai-coding-cn/glm-4.7-flash
 * - zai-coding-cn/glm-4v-flash
 * - openrouter/openrouter/free
 *
 * 只过滤 AgentService.listModels() 的日常下拉；模型配置页、插件快照不受影响。
 * 幂等：v3 命中跳过；自动从 v2 升级；锚点变化退出码 2。
 */
const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const marker = "free-models-only-v3";
const v2Marker = "free-models-only-v2";
const server = locateWebUiFile("dist", "server");
const target = server ? path.join(server, "agent-service.js") : null;
if (!target || !fs.existsSync(target)) {
	console.error("✗ 找不到 pi-web-ui 的 dist/server/agent-service.js");
	process.exit(1);
}

let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
	console.log(`✓ 模型可见性过滤已落地（${marker}，仅展示已验证免费模型）`);
	process.exit(0);
}

const fieldAnchor = `                name: this.cleanModelDisplayName(m.name),
                provider: m.provider,
                reasoning: m.reasoning,
                vision: m.input?.includes("image") ?? false,`;

const rules = `
/* ${marker}（兼容标记：${v2Marker}）——网页模型下拉的可见性过滤与“已验证免费”标记。 */
const PI_MODEL_VISIBILITY_DEFAULTS = {
	freeOnly: true,
	// 订阅制 provider：已付订阅费用，仍可在日常下拉中选择。
	subscriptionProviders: ["openai-codex", "zai-coding-cn"],
	// 按量计费中用户主动保留的高性价比款。
	allowModels: ["deepseek/deepseek-flash", "xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.5"],
	// 不能由 cost=0 自动推导；仅由 scripts/probe-free-models.js 多轮 HTTP 200 后人工加入。
	verifiedFreeModels: [
		"zai-coding-cn/glm-4.7-flash",
		"zai-coding-cn/glm-4v-flash",
		"openrouter/openrouter/free",
	],
};
let piModelVisibilityCache = { at: 0, cfg: null };
function piModelVisibilityConfig() {
	if (piModelVisibilityCache.cfg && Date.now() - piModelVisibilityCache.at < 60000) return piModelVisibilityCache.cfg;
	let cfg = PI_MODEL_VISIBILITY_DEFAULTS;
	try {
		const file = join(getAgentDir(), "model-visibility.json");
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, "utf8"));
			cfg = {
				freeOnly: raw.freeOnly !== false,
				subscriptionProviders: Array.isArray(raw.subscriptionProviders)
					? raw.subscriptionProviders.map((x) => String(x).toLowerCase())
					: PI_MODEL_VISIBILITY_DEFAULTS.subscriptionProviders,
				allowModels: Array.isArray(raw.allowModels)
					? raw.allowModels.map((x) => String(x).toLowerCase())
					: PI_MODEL_VISIBILITY_DEFAULTS.allowModels,
				verifiedFreeModels: Array.isArray(raw.verifiedFreeModels)
					? raw.verifiedFreeModels.map((x) => String(x).toLowerCase())
					: PI_MODEL_VISIBILITY_DEFAULTS.verifiedFreeModels,
			};
		}
	} catch {
		/* 配置不可用就退回内置默认 */
	}
	piModelVisibilityCache = { at: Date.now(), cfg };
	return cfg;
}
function piModelRef(model) {
	return \`\${model?.provider}/\${model?.id}\`.toLowerCase();
}
function piModelIsFree(model) {
	const cost = model?.cost ?? {};
	return !cost.input && !cost.output && !cost.cacheRead && !cost.cacheWrite;
}
function piModelIsVerifiedFree(model, cfg = piModelVisibilityConfig()) {
	return piModelIsFree(model) && new Set(cfg.verifiedFreeModels).has(piModelRef(model));
}
function filterVisiblePiModels(available) {
	const cfg = piModelVisibilityConfig();
	if (!cfg.freeOnly) return available;
	const subs = new Set(cfg.subscriptionProviders);
	const allow = new Set(cfg.allowModels);
	return available.filter((m) => {
		if (piModelIsVerifiedFree(m, cfg)) return true;
		if (subs.has(String(m.provider).toLowerCase())) return true;
		return allow.has(piModelRef(m));
	});
}
`;

if (source.includes(v2Marker)) {
	if (!source.includes(fieldAnchor) || !source.includes("free: piModelIsFree(m),")) {
		console.error("✗ v2 升级锚点未命中（listModels 的实现已变化），拒绝模糊替换");
		process.exit(2);
	}
	const oldBlock = source.lastIndexOf(`/* ${v2Marker}`);
	const oldBlockTail = "\n\t});\n}\n";
	const oldBlockEnd = source.indexOf(oldBlockTail, oldBlock);
	if (oldBlock < 0 || oldBlockEnd < 0) {
		console.error("✗ v2 规则块边界未找到，拒绝截断未知产物");
		process.exit(2);
	}
	source = source.replace("free: piModelIsFree(m),", "free: piModelIsVerifiedFree(m),");
	// v2 块未必在文件末尾（其他补丁可在其后继续插入代码）；只替换本块，绝不 slice 到 EOF。
	source = `${source.slice(0, oldBlock)}${rules}${source.slice(oldBlockEnd + oldBlockTail.length)}`;
	fs.writeFileSync(target, source);
	console.log(`✓ 已从 ${v2Marker} 升级到 ${marker}（只展示已验证免费模型）`);
	process.exit(0);
}

const anchor = `            const available = await mr.getAvailable();
            const models = available.map((m) => ({`;
const patched = `            const available = await mr.getAvailable();
            const models = filterVisiblePiModels(available).map((m) => ({`;
if (!source.includes(anchor) || source.includes("filterVisiblePiModels(")) {
	console.error("✗ 全新安装锚点未命中或已有未知同名标识符，拒绝模糊替换");
	process.exit(2);
}
if (!source.includes(fieldAnchor)) {
	console.error("✗ 字段锚点未命中，拒绝写入半成品");
	process.exit(2);
}
source = source.replace(anchor, patched);
source = source.replace(fieldAnchor, `${fieldAnchor}\n                free: piModelIsVerifiedFree(m),`);
source += rules;
fs.writeFileSync(target, source);
console.log(`✓ 已为 ${target} 注入仅限已验证免费模型的过滤（${marker}）`);
