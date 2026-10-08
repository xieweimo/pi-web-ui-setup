#!/usr/bin/env node
/**
 * 目标审查三处修复（适配 pi-web-ui 0.96.1 与 0.99.0 两代 dist/server/goal-service.js）。
 *
 * 0.96.1 → 0.99.0 结构差异（2026-10-04 重新适配）：
 *   · 审查提示词方法 `reviewerPrompt(goal, round, maxRounds, output, gitDiff, customPrompt)`
 *     改成中英双模板的 `reviewerRoundPrompt(goalText, round, budget, execOutput, planDesc)`；
 *   · 审查由「主对话自己干活」改成「委托执行者」（`dispatchExecutor` → `askDelegatedReview`），
 *     所以工具证据要取自**执行者会话**（`host.getConv(execId).session`）；
 *   · 「上一轮意见」不再是 `g.feedback`，而是 `runDelegatedLoop` 里的局部变量 `feedback`
 *     （g.feedback 每轮清空）——因此无需「留住上一轮意见」那一对锚点，改为在 verdict
 *     落地后统一兜底（`verdict.feedback = ensureReviewerFeedback(...)`）。
 *
 * 背景（2026-09-29 实测）：m720q 部署类目标连烧 24 轮全 fail，根因不在「任务没做」，
 * 而在审查循环的输入与判定：
 *   ① 审查者只拿到「主模型最后一段文本 + git diff」，远程部署证据（systemctl /
 *      SHOW TABLES / SSH 命令输出）根本进不了它的视野；
 *   ② 解析成功但 feedback 为空时照样判 fail，Agent 拿到空意见白跑一轮（实测有 2 轮）；
 *   ③ 目标写成「完成后续全部阶段」时，未声称完成的后续阶段也构成 fail 理由 →
 *      任何认真审查者都只能一路 fail 到轮数上限。
 *
 * 本补丁对应三处修复（marker: goal-review-evidence-v1）：
 *   1) 空 feedback 兜底：优先沿用上一轮意见，否则给一条可执行的失败说明；
 *   2) 审查输入新增「工具/命令执行证据」自动采集（含 SSH 等远程命令输出）+
 *      可选证据目录 docs/goal-evidence/*.md；
 *   3) reviewerPrompt 内置判定粒度：只判本轮声称完成的条目、忽略与目标无关的本地
 *      改动、无证据的声称必须 fail、feedback 禁止为空。
 *
 * 幂等：以 marker 判定；锚点命中次数不为 1 时退出码 2（不做模糊替换）。
 * 回滚：--remove 按 marker 反向还原（先备份）。
 * 备份：改前复制到 work/backups/goal-review/goal-service.js.<时间戳>.bak
 *
 * 用法：
 *   node patches/patch-pi-web-ui-goal-review.js
 *   node patches/patch-pi-web-ui-goal-review.js --remove
 *
 * 退出码：0 = 已应用/已存在；1 = 找不到目标；2 = 锚点失效。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const MARKER = "goal-review-evidence-v1";
const REMOVE = process.argv.includes("--remove");
const ROOT = path.resolve(__dirname, "..");
const BACKUP_DIR = path.join(ROOT, "work", "backups", "goal-review");

const server = locateWebUiFile("dist", "server");
const target = server ? path.join(server, "goal-service.js") : null;
if (!target || !fs.existsSync(target)) {
	console.error("✗ 找不到 pi-web-ui 的 dist/server/goal-service.js");
	process.exit(1);
}
const ORIGINAL = fs.readFileSync(target, "utf8");

// ---------------------------------------------------------------------------
// 新增方法：审查证据采集
// ---------------------------------------------------------------------------
const EVIDENCE_METHOD = [
	`    /**`,
	`     * ${MARKER}：为审查者采集「可验证证据」——最近的工具/命令执行摘要（含 SSH 等`,
	`     * 远程命令的输出），以及约定的证据目录文件。起因：审查者原本只拿到「最后一段`,
	`     * 文本 + git diff」，远程部署类目标的证据（systemctl / SHOW TABLES / 日志）根本`,
	`     * 进不了它的视野，于是只能反复判 fail。`,
	`     */`,
	`    collectEvidenceDigest(session, cwd, limit = 12) {`,
	`        const parts = [];`,
	`        try {`,
	`            const messages = session?.agent?.state?.messages;`,
	`            if (Array.isArray(messages)) {`,
	`                const lines = [];`,
	`                for (let i = messages.length - 1; i >= 0 && lines.length < limit; i--) {`,
	`                    const m = messages[i];`,
	`                    if (!m || typeof m !== "object")`,
	`                        continue;`,
	`                    if (m.role === "bashExecution") {`,
	`                        const cmd = String(m.command ?? "").replace(/\\s+/g, " ").slice(0, 240);`,
	`                        const out = String(m.output ?? "").trim();`,
	`                        lines.push(\`[bash] \${cmd}\\n  → exit \${m.exitCode ?? "?"}\${out ? \`: \${out.slice(-400)}\` : ""}\`);`,
	`                        continue;`,
	`                    }`,
	`                    if (m.role === "toolResult") {`,
	`                        const name = m.toolName ?? m.name ?? "tool";`,
	`                        const text = (Array.isArray(m.content) ? m.content : [])`,
	`                            .map((c) => (c && c.type === "text" ? c.text : ""))`,
	`                            .join(" ")`,
	`                            .trim();`,
	`                        lines.push(\`[\${name}]\${m.isError ? " ERROR" : ""} \${text.slice(0, 400)}\`);`,
	`                        continue;`,
	`                    }`,
	`                    if (m.role === "assistant" && Array.isArray(m.content)) {`,
	`                        for (const c of m.content) {`,
	`                            if (c && c.type === "toolCall") {`,
	`                                let args = "";`,
	`                                try {`,
	`                                    args = JSON.stringify(c.arguments ?? c.args ?? {});`,
	`                                }`,
	`                                catch {`,
	`                                    args = "";`,
	`                                }`,
	`                                lines.push(\`[call \${c.name ?? "?"}] \${String(args).slice(0, 300)}\`);`,
	`                                break;`,
	`                            }`,
	`                        }`,
	`                    }`,
	`                }`,
	`                if (lines.length > 0) {`,
	`                    parts.push("# Tool / command evidence (auto-collected, oldest first)\\n" + lines.reverse().join("\\n"));`,
	`                }`,
	`            }`,
	`        }`,
	`        catch {`,
	`            // 证据采集失败绝不影响审查本身`,
	`        }`,
	`        try {`,
	`            const dir = join(cwd ?? "", "docs", "goal-evidence");`,
	`            if (cwd && existsSync(dir)) {`,
	`                const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-2);`,
	`                for (const f of files) {`,
	`                    const body = readFileSync(join(dir, f), "utf8").trim();`,
	`                    if (body)`,
	`                        parts.push(\`# Evidence file: docs/goal-evidence/\${f}\\n\${body.slice(0, 2000)}\`);`,
	`                }`,
	`            }`,
	`        }`,
	`        catch {`,
	`            // 同上`,
	`        }`,
	`        return parts.join("\\n\\n").slice(0, 6000);`,
	`    }`,
	`    /** Build a "provider/id" or null for the reviewer model, validating it exists. */`,
].join("\n");

// 0.99.0 把审查方法改名（reviewerRoundPrompt）并重写了提示词：证据采集方法要插在
// `askDelegatedReview` 之前，不能再靠旧结构里的「Build a provider/id」注释定位。
const LEGACY_METHOD_ANCHOR = `    /** Build a "provider/id" or null for the reviewer model, validating it exists. */`;
const MODERN_METHOD_ANCHOR = `    /** 审查：把审查指令交给主对话，等 verdict；无 JSON 允许重试一次。 */`;
const EVIDENCE_METHOD_MODERN = EVIDENCE_METHOD.replace(LEGACY_METHOD_ANCHOR, MODERN_METHOD_ANCHOR);

// ---------------------------------------------------------------------------
// 替换对（from → to）；--remove 时反向执行。
// 0.99.0 与旧版结构差异太大，两代各一张表：按特征选择，不混在一起（避免误命中）。
// ---------------------------------------------------------------------------
const LEGACY_PAIRS = [
	{
		label: "空 feedback 兜底函数（导出）",
		from: `/** diff 正文进审查 prompt 的截断上限（完整规模信息走 [diff-meta] 尾段）。 */`,
		to: [
			`/**`,
			` * ${MARKER}：空 feedback 兜底（纯函数，便于单测）。`,
			` * 审查模型可能返回 {"verdict":"fail","feedback":""}（或审查过程出错）；调用方若不兜底，`,
			` * 就会把「请根据以上意见修改」加一个空意见发给 Agent，白烧一轮（实测出现过 2 轮）。`,
			` * 规则：有实质意见 → 原样返回；空但有上一轮意见 → 沿用并标注；都空 → 给可执行说明。`,
			` */`,
			`export function ensureReviewerFeedback(feedback, prevFeedback) {`,
			`    const current = typeof feedback === "string" ? feedback.trim() : "";`,
			`    if (current)`,
			`        return feedback;`,
			`    const prev = typeof prevFeedback === "string" ? prevFeedback.trim() : "";`,
			`    if (prev)`,
			`        return \`（本轮审查未给出意见，沿用上一轮）\\n\${prev}\`;`,
			`    return "（本轮审查未给出意见）请对照目标文本逐条核对：把本轮声称完成项对应的命令原文与输出贴进最后一条消息，并把证据归档到 docs/ 下；未完成项明确列出。";`,
			`}`,
			`/** diff 正文进审查 prompt 的截断上限（完整规模信息走 [diff-meta] 尾段）。 */`,
		].join("\n"),
	},
	{
		label: "node:fs import",
		from: `import { join } from "node:path";`,
		to: [`import { join } from "node:path";`, `import { existsSync, readFileSync, readdirSync } from "node:fs"; // ${MARKER}`].join("\n"),
	},
	{
		label: "collectEvidenceDigest 方法",
		from: `    /** Build a "provider/id" or null for the reviewer model, validating it exists. */`,
		to: EVIDENCE_METHOD,
	},
	{
		label: "reviewerPrompt 签名",
		from: `    reviewerPrompt(goal, round, maxRounds, output, gitDiff, customPrompt = "") {`,
		to: `    reviewerPrompt(goal, round, maxRounds, output, gitDiff, customPrompt = "", evidenceDigest = "") {`,
	},
	{
		label: "审查输入·证据段",
		from: [
			`            \`# Git diff (if any)\`, // eslint-disable-line no-regex-spaces`,
			`            gitDiff.length > 0 ? gitDiff : "(no staged/committed changes detected)",`,
		].join("\n"),
		to: [
			`            \`# Git diff (if any)\`, // eslint-disable-line no-regex-spaces`,
			`            gitDiff.length > 0 ? gitDiff : "(no staged/committed changes detected)",`,
			`            \`\`,`,
			`            \`# Tool / command evidence (auto-collected by ${MARKER})\`,`,
			`            evidenceDigest.length > 0 ? evidenceDigest : "(no tool output captured this round)",`,
		].join("\n"),
	},
	{
		label: "内置判定粒度",
		from: `            \`Decide: does the work satisfy the goal? If yes, respond with ONLY a JSON object with this exact shape (no markdown fences, no extra text):\`, // eslint-disable-line max-len`,
		to: [
			`            \`# Scoring rules (mandatory — these override any earlier wording)\`, // ${MARKER}`,
			`            \`- Score ONLY the items this round's output CLAIMS to have finished. Items not claimed yet (later phases of a multi-phase goal) are NOT grounds for a fail.\`, // eslint-disable-line max-len`,
			`            \`- Ignore local changes unrelated to the goal (patches for other projects, tooling, model config): never fail because of them, never mention them.\`, // eslint-disable-line max-len`,
			`            \`- If a claimed item has NO matching command output or file evidence in the materials above, it MUST fail — name the exact missing command in the feedback.\`, // eslint-disable-line max-len`,
			`            \`- An empty feedback string is an invalid response. Always write concrete, actionable feedback.\`, // eslint-disable-line max-len`,
			`            \`\`,`,
			`            \`Decide: does the work satisfy the goal? If yes, respond with ONLY a JSON object with this exact shape (no markdown fences, no extra text):\`, // eslint-disable-line max-len`,
		].join("\n"),
	},
	{
		label: "调用处采集证据",
		from: `                await reviewer.prompt(this.reviewerPrompt(goalText, g.round, reviewCap, finalText, diff, reviewPrompt));`,
		to: [
			`                const evidenceDigest = this.collectEvidenceDigest(mainSession, mainConv.cwd); // ${MARKER}`,
			`                await reviewer.prompt(this.reviewerPrompt(goalText, g.round, reviewCap, finalText, diff, reviewPrompt, evidenceDigest));`,
		].join("\n"),
	},
	{
		label: "留住上一轮意见",
		from: [
			`        g.reviewing = true;`,
			`        g.round += 1;`,
			`        g.verdict = "pending";`,
			`        g.feedback = undefined;`,
		].join("\n"),
		to: [
			`        g.reviewing = true;`,
			`        g.round += 1;`,
			`        // ${MARKER}：清空前留住上一轮意见，供本轮空 feedback 兜底时沿用。`,
			`        const prevFeedback = typeof g.feedback === "string" ? g.feedback : "";`,
			`        g.verdict = "pending";`,
			`        g.feedback = undefined;`,
		].join("\n"),
	},
	{
		label: "空 feedback 兜底",
		from: [
			`        g.reviewing = false;`,
			`        g.verdict = reviewerVerdict;`,
			`        g.feedback = reviewerFeedback;`,
		].join("\n"),
		to: [
			`        // ${MARKER}：空 feedback 不再注入空指令（兜底规则见 ensureReviewerFeedback）。`,
			`        reviewerFeedback = ensureReviewerFeedback(reviewerFeedback, prevFeedback);`,
			`        g.reviewing = false;`,
			`        g.verdict = reviewerVerdict;`,
			`        g.feedback = reviewerFeedback;`,
		].join("\n"),
	},
];

// ---------------------------------------------------------------------------
// 0.99.0 结构下的替换表（中英双模板 + 委托执行）
// ---------------------------------------------------------------------------
const MODERN_PAIRS = [
	LEGACY_PAIRS[0], // 空 feedback 兜底函数（导出）——锚点两代相同
	LEGACY_PAIRS[1], // node:fs import——锚点两代相同
	{
		label: "collectEvidenceDigest 方法（0.99.0 结构）",
		from: MODERN_METHOD_ANCHOR,
		to: EVIDENCE_METHOD_MODERN,
	},
	{
		label: "reviewerRoundPrompt 签名",
		from: '    reviewerRoundPrompt(goalText, round, budget, execOutput, planDesc = "") {',
		to: '    reviewerRoundPrompt(goalText, round, budget, execOutput, planDesc = "", evidenceDigest = "") {',
	},
	{
		label: "审查输入·证据段（中文模板）",
		from: '你可以用只读手段核实：read / grep / scm（只读 git）/ 只读 bash（跑测试）。',
		to: '【工具 / 命令执行证据（自动采集，最早在前）】\\n${evidenceDigest || "（本轮未采集到工具输出）"}\\n\\n你可以用只读手段核实：read / grep / scm（只读 git）/ 只读 bash（跑测试）。',
	},
	{
		label: "审查输入·证据段（英文模板）",
		from: 'You may verify with read-only means: read / grep / scm (read-only git) / read-only bash (run tests).',
		to: '# Tool / command evidence (auto-collected, oldest first)\\n${evidenceDigest || "(no tool output captured this round)"}\\n\\nYou may verify with read-only means: read / grep / scm (read-only git) / read-only bash (run tests).',
	},
	{
		label: "内置判定粒度（中文模板）",
		from: '你是严格、独立的验收者。只判断目标是否被完全满足：不要相信描述，去看工作区的实际状态。',
		to: '你是严格、独立的验收者。只判断目标是否被完全满足：不要相信描述，去看工作区的实际状态。\\n\\n【判定规则（强制，覆盖此前任何措辞）】\\n- 只判本轮自述【声称完成】的条目；未声称完成的后续阶段不构成 fail 理由。\\n- 与本目标无关的本地改动（其他项目的补丁、工具配置、模型设置）不得作为 fail 理由，也不要写进 feedback。\\n- 声称完成、但材料里没有对应命令输出或文件证据的条目必须 fail，并在 feedback 里点名缺少哪条命令的输出。\\n- feedback 永远不得为空；材料不足时 verdict 仍为 fail，并写明还缺哪些材料才能判定。',
	},
	{
		label: "内置判定粒度（英文模板）",
		from: 'You are a strict, independent acceptor. Judge only whether the goal is fully satisfied: do not trust the summary — inspect the actual workspace state.',
		to: 'You are a strict, independent acceptor. Judge only whether the goal is fully satisfied: do not trust the summary — inspect the actual workspace state.\\n\\n# Scoring rules (mandatory — these override any earlier wording)\\n- Score ONLY the items this round claims to have finished. Later phases not claimed yet are NOT grounds for a fail.\\n- Ignore local changes unrelated to the goal (patches for other projects, tooling, model config): never fail because of them, never mention them.\\n- If a claimed item has NO matching command output or file evidence in the materials above, it MUST fail — name the exact missing command in the feedback.\\n- An empty feedback string is an invalid response. Always write concrete, actionable feedback.',
	},
	{
		label: "askDelegatedReview 签名",
		from: '    async askDelegatedReview(conv, goalGeneration, round, budget, execOutput) {',
		to: '    async askDelegatedReview(conv, goalGeneration, round, budget, execOutput, evidenceDigest = "") {',
	},
	{
		label: "审查输入带上证据",
		from: '                ? this.reviewerRoundPrompt(conv.goal.goal ?? "", round, budget, execOutput, planDesc)',
		to: '                ? this.reviewerRoundPrompt(conv.goal.goal ?? "", round, budget, execOutput, planDesc, evidenceDigest)',
	},
	{
		label: "调用处采集证据（执行者会话）",
		from: '            const verdict = await this.askDelegatedReview(conv, goalGeneration, round, budget, sample.output);',
		to: [
			`            const execSession = this.host.getConv?.(execId)?.session; // ${MARKER}：证据取自执行者会话`,
			`            const evidenceDigest = this.collectEvidenceDigest(execSession, conv.cwd);`,
			// 一行 stderr 即可把「证据段到底空不空」变成可观测事实（2026-10-04 实测：
			// 审查指令不经 WS 帧下发、目标会话也不落盘，没有这行就只能靠间接证据）。
			`            console.error(\`[goal-evidence] digest=\${evidenceDigest.length}B lines=\${evidenceDigest ? evidenceDigest.split("\\n").length : 0} session=\${execSession ? "yes" : "no"}\`); // ${MARKER}`,
			`            const verdict = await this.askDelegatedReview(conv, goalGeneration, round, budget, sample.output, evidenceDigest);`,
		].join("\n"),
	},
	{
		label: "空 feedback 兜底（verdict 落地处）",
		from: '            // 审查结论卡：把 verdict JSON 翻译成人话框住（裸 JSON 留在流里，但不再是唯一载体）。',
		to: [
			`            // ${MARKER}：空 feedback 不再注入空指令（规则见 ensureReviewerFeedback）。`,
			`            verdict.feedback = ensureReviewerFeedback(verdict.feedback, feedback);`,
			`            // 审查结论卡：把 verdict JSON 翻译成人话框住（裸 JSON 留在流里，但不再是唯一载体）。`,
		].join("\n"),
	},
];

// 特征：0.99.0 起审查方法叫 reviewerRoundPrompt（旧版是 reviewerPrompt）。
const PAIRS = ORIGINAL.includes("reviewerRoundPrompt(") ? MODERN_PAIRS : LEGACY_PAIRS;

let src = ORIGINAL;

if (REMOVE) {
	if (!src.includes(MARKER)) {
		console.log("✓ 未发现目标审查补丁，无需回滚");
		process.exit(0);
	}
	for (const { label, from, to } of PAIRS) {
		if (!src.includes(to)) continue;
		src = src.replace(to, from);
		console.log(`✓ 已回滚：${label}`);
	}
	backup(target);
	fs.writeFileSync(target, src, "utf8");
	console.log(`✓ ${MARKER} 回滚完成`);
	process.exit(0);
}

if (src.includes(MARKER)) {
	console.log(`✓ ${MARKER} 补丁已存在`);
	process.exit(0);
}

// 先全部校验锚点命中次数，再统一写入：避免替换到一半失败留下半成品。
for (const { from, label } of PAIRS) {
	const count = src.split(from).length - 1;
	if (count !== 1) {
		console.error(`✗ 锚点失效：「${label}」命中 ${count} 次（应为 1）——pi-web-ui 可能已升级，需重新适配`);
		process.exit(2);
	}
}
for (const { from, to, label } of PAIRS) {
	src = src.replace(from, to);
	console.log(`✓ 已应用：${label}`);
}
backup(target);
fs.writeFileSync(target, src, "utf8");
console.log(`✓ ${MARKER} 完成：空 feedback 兜底 + 工具证据采集 + 内置判定粒度`);

function backup(file) {
	try {
		fs.mkdirSync(BACKUP_DIR, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		fs.writeFileSync(path.join(BACKUP_DIR, `goal-service.js.${stamp}.bak`), ORIGINAL, "utf8");
	} catch {
		// 备份失败不阻断（README 里说明了备份位置；失败时用户仍可 npm 重装还原）
	}
}
