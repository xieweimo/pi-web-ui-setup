/**
 * codex-usage —— 订阅额度 / 成本显示（服务端入口）
 *
 * 两条数据线，按当前会话模型自动二选一：
 *   1) 订阅额度：读 <agentDir>/auth.json 里 openai-codex 的 OAuth 凭证，请求
 *      ChatGPT 后端 GET https://chatgpt.com/backend-api/wham/usage
 *      → 5 小时窗口 / 每周窗口的已用百分比、重置时间、可用 reset 次数。
 *   2) 按量计费：非订阅模型时读取当前对话完整活动分支，只累计当前选中 provider
 *      （如 deepseek）的已结算调用成本；不受上下文压缩影响，也不混入 Codex/其他
 *      provider，再乘实时汇率显示人民币。
 *
 * 结果经 host.broadcast({ state }) 推给同插件的客户端视图（client/entry.mjs）。
 * 只读凭证、不写、不打印；token 永远不进日志与广播数据。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** ChatGPT 后端的订阅用量端点（Codex CLI /status 背后的同一份数据）。 */
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** 免费汇率源（无需 key），返回 rates.CNY。 */
const FX_URL = "https://open.er-api.com/v6/latest/USD";
/** 内置订阅适配器：目前只有 Codex 有可稳定读取的额度窗口接口。 */
const CODEX_PROVIDER = "openai-codex";
const BILLING_MODES = new Set(["subscription", "metered", "prepaid", "free", "hybrid", "unknown"]);
/**
 * 官方按量计费 endpoint：API key 命中这些域名时按官方目录价计费（高置信度）。
 * 覆盖欧美、国产与聚合平台的主流厂商；未收录域名不会误判，只会走后续信号。
 */
const OFFICIAL_METERED_HOSTS = new Set([
	// OpenAI / Anthropic / Google
	"api.openai.com",
	"api.anthropic.com",
	"generativelanguage.googleapis.com",
	"aiplatform.googleapis.com",
	"portal.qwen.ai",
	// 国产厂商
	"api.deepseek.com",
	"api.moonshot.cn",
	"api.moonshot.ai",
	"api.kimi.com",
	"open.bigmodel.cn",
	"dashscope.aliyuncs.com",
	"dashscope-intl.aliyuncs.com",
	"ark.cn-beijing.volces.com",
	"ark.ap-southeast.volces.com",
	"api.minimax.chat",
	"api.minimaxi.com",
	"api.lingyiwanwu.com",
	"api.stepfun.com",
	"open.baichuan-ai.com",
	"aip.baidubce.com",
	"qianfan.baidubce.com",
	"hunyuan.tencentcloudapi.com",
	"api.siliconflow.cn",
	"api.siliconflow.com",
	// 欧美其他
	"api.mistral.ai",
	"api.x.ai",
	"api.cohere.com",
	"api.groq.com",
	"api.perplexity.ai",
	"api.together.xyz",
	"api.together.ai",
	"api.fireworks.ai",
	"api.cerebras.ai",
	"api.novita.ai",
]);
/**
 * provider 名字层面的按量厂商白名单：当没有 baseUrl 或 baseUrl 官方时的中置信度信号。
 * 仅收录以 API 按量为主要商业模式的官方 provider 名。
 */
const KNOWN_METERED_PROVIDERS = new Set([
	"openai", "anthropic", "google", "google-vertex", "deepseek", "mistral", "xai",
	"cohere", "groq", "perplexity", "perplexity-labs", "together", "fireworks",
	"moonshot", "kimi", "zai", "zhipu", "bigmodel", "qwen", "dashscope",
	"minimax", "baichuan", "stepfun", "lingyiwanwu", "baidu", "tencent", "hunyuan",
	"doubao", "volcengine", "siliconflow", "novita", "cerebras", "cerebras-code",
]);
/** 汇率缓存时长：12 小时。 */
const FX_TTL_MS = 12 * 3600_000;
/** 汇率兜底值（抓取失败且无缓存时使用）。 */
const FX_FALLBACK = 7.2;

/** pi 的配置目录（agentDir）：可用 PI_CODING_AGENT_DIR 覆盖。 */
function agentDir() {
	const fromEnv = (process.env.PI_CODING_AGENT_DIR || "").trim();
	return fromEnv || join(homedir(), ".pi", "agent");
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 读 openai-codex 的 OAuth 凭证；缺失/结构不对返回 null（绝不打印内容）。 */
function readCodexAuth() {
	const auth = readJson(join(agentDir(), "auth.json"));
	const cred = auth?.[CODEX_PROVIDER];
	if (!cred || typeof cred.access !== "string" || !cred.access) return null;
	return {
		access: cred.access,
		// 账号 id：优先 auth.json 字段，兜底从 access token 的 JWT claim 里取
		accountId:
			typeof cred.accountId === "string" && cred.accountId
				? cred.accountId
				: (jwtClaim(cred.access, "https://api.openai.com/auth", "chatgpt_account_id") ?? ""),
		expires: typeof cred.expires === "number" ? cred.expires : 0,
	};
}

function jwtClaim(token, claimKey, field) {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		return payload?.[claimKey]?.[field] ?? null;
	} catch {
		return null;
	}
}

/** 代理地址：插件设置 → 环境变量 → pi 全局设置 httpProxy。 */
function resolveProxy(cfg) {
	const fromCfg = String(cfg.proxy ?? "").trim();
	if (fromCfg) return fromCfg;
	const fromEnv = (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim();
	if (fromEnv) return fromEnv;
	const settings = readJson(join(agentDir(), "settings.json"));
	const fromPi = typeof settings?.httpProxy === "string" ? settings.httpProxy.trim() : "";
	return fromPi || "";
}

// ---------------------------------------------------------------------------
// HTTP（支持 HTTP 代理 CONNECT 隧道；Node 原生 fetch 不读代理环境变量）
// ---------------------------------------------------------------------------

function dechunk(buf) {
	const parts = [];
	let i = 0;
	while (i < buf.length) {
		const nl = buf.indexOf("\r\n", i);
		if (nl < 0) break;
		const size = parseInt(buf.subarray(i, nl).toString("latin1").split(";")[0], 16);
		if (!Number.isFinite(size) || size <= 0) break;
		const start = nl + 2;
		parts.push(buf.subarray(start, start + size));
		i = start + size + 2;
	}
	return Buffer.concat(parts);
}

/** 解析 HTTP/1.1 原始响应（仅 CONNECT 隧道分支需要）。 */
function parseRawResponse(buf) {
	const split = buf.indexOf("\r\n\r\n");
	if (split < 0) throw new Error("代理响应缺少头部");
	const head = buf.subarray(0, split).toString("latin1");
	let body = buf.subarray(split + 4);
	const lines = head.split("\r\n");
	const status = Number(lines[0].split(" ")[1]) || 0;
	const headers = {};
	for (const line of lines.slice(1)) {
		const i = line.indexOf(":");
		if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
	}
	if ((headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) body = dechunk(body);
	return { status, body: body.toString("utf8") };
}

function directGet(url, headers, timeoutMs) {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			url,
			{ method: "GET", headers: { ...headers, "Accept-Encoding": "identity" }, timeout: timeoutMs },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
				);
			},
		);
		req.on("timeout", () => req.destroy(new Error("请求超时")));
		req.on("error", reject);
		req.end();
	});
}

function proxyGet(url, headers, proxy, timeoutMs) {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const px = new URL(proxy);
		const port = px.port ? Number(px.port) : px.protocol === "https:" ? 443 : 80;
		const req = httpRequest({
			host: px.hostname,
			port,
			method: "CONNECT",
			path: `${target.hostname}:443`,
			headers: { Host: `${target.hostname}:443` },
			timeout: timeoutMs,
		});
		req.on("connect", (res, socket) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
				return;
			}
			const tls = tlsConnect({ socket, servername: target.hostname }, () => {
				const lines = [
					`GET ${target.pathname}${target.search} HTTP/1.1`,
					`Host: ${target.hostname}`,
					...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
					"Accept-Encoding: identity",
					"Connection: close",
				];
				tls.write(`${lines.join("\r\n")}\r\n\r\n`);
			});
			const chunks = [];
			tls.on("data", (c) => chunks.push(c));
			tls.on("end", () => {
				try {
					resolve(parseRawResponse(Buffer.concat(chunks)));
				} catch (err) {
					reject(err);
				}
			});
			tls.on("error", reject);
			tls.setTimeout(timeoutMs, () => tls.destroy(new Error("响应超时")));
		});
		req.on("timeout", () => req.destroy(new Error("代理连接超时")));
		req.on("error", reject);
		req.end();
	});
}

function httpGet(url, headers, proxy, timeoutMs = 20_000) {
	return proxy ? proxyGet(url, headers, proxy, timeoutMs) : directGet(url, headers, timeoutMs);
}

// ---------------------------------------------------------------------------
// 数据组装
// ---------------------------------------------------------------------------

function normWindow(w) {
	if (!w || typeof w !== "object") return null;
	const used = Number(w.used_percent);
	const resetAtSec = Number(w.reset_at);
	return {
		usedPercent: Number.isFinite(used) ? used : null,
		windowSeconds: Number(w.limit_window_seconds) || null,
		resetAt: Number.isFinite(resetAtSec) ? resetAtSec * 1000 : null,
		resetAfterSeconds: Number(w.reset_after_seconds) || null,
	};
}

/** 当前选中模型优先；没有时才退回最后一条 assistant 消息（兼容旧版宿主）。 */
function pickModel(conv) {
	// 0.94.1 的插件快照直接提供 canonical model（provider/model）。必须优先用它：
	// 消息列表可能刚经历压缩，或者用户刚切模型、当前回复仍在流式，此时末条已完成消息
	// 仍属于旧 provider，不能拿它冒充当前选择。
	const canonical = typeof conv?.model === "string" ? conv.model.trim() : "";
	const slash = canonical.indexOf("/");
	if (slash > 0 && slash < canonical.length - 1) {
		return { provider: canonical.slice(0, slash), model: canonical.slice(slash + 1) };
	}
	const active = conv?.activeModel;
	if (active && (active.provider || active.model || active.id)) {
		return { provider: active.provider ?? null, model: active.model ?? active.id ?? null };
	}
	const messages = Array.isArray(conv?.messages) ? conv.messages : [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m?.role === "assistant" && (m.provider || m.model)) {
			return { provider: m.provider ?? null, model: m.model ?? null };
		}
	}
	const streaming = conv?.streamingMessage;
	if (streaming && (streaming.provider || streaming.model)) {
		return { provider: streaming.provider ?? null, model: streaming.model ?? null };
	}
	return null;
}

/**
 * 用户可覆盖任意 provider 或 provider/model 的计费方式。
 * 支持 JSON（推荐）：{"anthropic":"subscription","openrouter":"credits"}
 * 也兼容逗号写法：anthropic=subscription,openrouter=credits。
 */
function parseBillingOverrides(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return {};
	let input = null;
	try {
		input = JSON.parse(text);
	} catch {
		input = Object.fromEntries(
			text
				.split(/[,;\n]+/)
				.map((part) => part.trim())
				.filter(Boolean)
				.map((part) => {
					const i = part.indexOf("=");
					return i > 0 ? [part.slice(0, i).trim(), part.slice(i + 1).trim()] : ["", ""];
				})
				.filter(([key]) => key),
		);
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const out = {};
	for (const [key, value] of Object.entries(input)) {
		const id = String(key).trim();
		const spec = typeof value === "string" ? { mode: value } : value;
		const mode = String(spec?.mode ?? "").trim().toLowerCase();
		if (!id || !BILLING_MODES.has(mode)) continue;
		out[id] = {
			mode,
			label: typeof spec?.label === "string" ? spec.label.trim() : "",
			note: typeof spec?.note === "string" ? spec.note.trim() : "",
		};
	}
	return out;
}

function authMetadata(provider) {
	const auth = readJson(join(agentDir(), "auth.json"));
	const entry = auth?.[provider];
	return entry && typeof entry === "object"
		? { type: String(entry.type ?? ""), hasKey: Boolean(entry.key), hasAccess: Boolean(entry.access) }
		: { type: "", hasKey: false, hasAccess: false };
}

function modelMetadata(provider, model) {
	const store = readJson(join(agentDir(), "models-store.json"));
	const rows = Array.isArray(store?.[provider]?.models) ? store[provider].models : [];
	const hit = (model && rows.find((item) => item?.id === model)) ?? rows[0] ?? null;
	return {
		baseUrl: String(hit?.baseUrl ?? ""),
		api: String(hit?.api ?? ""),
	};
}

function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * 分层识别：精确 model 规则 > provider 规则 > 内置 adapter / 已知产品特征 > 认证类型 > 官方 endpoint > 名字白名单。
 * 中转站与无法证明的计费关系一律 unknown，绝不把目录价冒充真实账单。
 * inject 仅用于单元测试注入元数据，生产代码不传。
 */
function billingProfile(provider, model, cfg, inject = {}) {
	const p = String(provider ?? "").trim();
	const m = String(model ?? "").trim();
	const overrides = parseBillingOverrides(cfg.billingOverrides);
	const exact = p && m ? overrides[`${p}/${m}`] : null;
	const broad = p ? overrides[p] : null;
	const override = exact ?? broad;
	if (override) return { ...override, source: exact ? "model-rule" : "provider-rule", confidence: "explicit" };
	if (p === CODEX_PROVIDER) return { mode: "subscription", label: "ChatGPT / Codex", source: "builtin-adapter", confidence: "high" };

	const meta = inject.modelMeta ?? modelMetadata(p, m);
	const auth = inject.authMeta ?? authMetadata(p);
	const hostname = hostOf(meta.baseUrl);
	const signal = { baseUrl: meta.baseUrl, authType: auth.type };
	const officialHost = OFFICIAL_METERED_HOSTS.has(hostname);

	// Coding Plan 订阅：GLM Coding Plan、Kimi for Coding 等以 /coding/ 路径或 provider 名命名。
	if (/\/coding(?:\/|$)/i.test(meta.baseUrl) || /coding[-_]?plan/i.test(p)) {
		return { mode: "subscription", label: p, source: "known-coding-plan", confidence: "medium", ...signal };
	}
	if (hostname === "openrouter.ai" || p === "openrouter") {
		return { mode: "prepaid", label: "OpenRouter credits", source: "known-prepaid", confidence: "medium", ...signal };
	}
	if (["localhost", "127.0.0.1", "::1"].includes(hostname) && !auth.hasKey && !auth.hasAccess) {
		return { mode: "free", label: "本地模型", source: "local-endpoint", confidence: "high", ...signal };
	}
	// OAuth 登录（Claude Code / Gemini CLI / Qwen OAuth 等）都是订阅/套餐制，不走 API 账单。
	if (auth.type === "oauth") {
		return { mode: "subscription", label: p, source: "oauth", confidence: "medium", ...signal };
	}
	if (auth.type === "api_key" && officialHost) {
		return { mode: "metered", label: p, source: "official-api-key", confidence: "high", ...signal };
	}
	// endpoint 官方但 auth.json 缺记录（例如模型目录缓存）：endpoint 仍可作中置信度证据。
	if (officialHost) {
		return { mode: "metered", label: p, source: "official-endpoint", confidence: "medium", ...signal };
	}
	// 没有反向证据（自定义域名）时，主流按量厂商名可作为中置信度信号。
	if (KNOWN_METERED_PROVIDERS.has(p.toLowerCase()) && !hostname) {
		return { mode: "metered", label: p, source: "known-provider", confidence: "medium", ...signal };
	}
	if (auth.type === "api_key" || hostname) {
		return {
			mode: "unknown",
			label: p,
			note: hostname ? `自定义或中转 endpoint：${hostname}` : "API key 的实际结算方式未知",
			source: "unverified-endpoint",
			confidence: "low",
			...signal,
		};
	}
	const fallback = String(cfg.defaultBillingMode ?? "unknown").trim().toLowerCase();
	return {
		mode: BILLING_MODES.has(fallback) ? fallback : "unknown",
		label: p,
		source: "default",
		confidence: "low",
		...signal,
	};
}

function newCostBook(source) {
	return { source, providers: new Map() };
}

function addCost(book, provider, model, profile, cost, kind) {
	const key = String(provider || "unknown");
	const mode = profile.mode;
	let row = book.providers.get(key);
	if (!row) {
		row = {
			provider: key,
			models: new Set(),
			mode,
			billingSource: profile.source,
			billingConfidence: profile.confidence,
			billingLabel: profile.label || key,
			billingNote: profile.note || "",
			baseUrl: profile.baseUrl || "",
			authType: profile.authType || "",
			usd: 0,
			theoreticalUsd: 0,
			messages: 0,
			auxiliaryCalls: 0,
			missingCostMessages: 0,
		};
		book.providers.set(key, row);
	}
	if (model) row.models.add(String(model));
	// 同一 provider 若会话中模型级覆盖不同，保守标为 mixed，避免把金额错误称为真实账单。
	if (row.mode !== mode) {
		row.mode = "unknown";
		row.billingConfidence = "low";
		row.billingNote = "同一 provider 在当前会话中命中了不同计费规则";
	}
	if (!Number.isFinite(cost)) {
		row.missingCostMessages += 1;
		return;
	}
	if (mode === "subscription" || mode === "free") row.theoreticalUsd += cost;
	else row.usd += cost;
	if (kind === "message") row.messages += 1;
	else row.auxiliaryCalls += 1;
}

function finalizeCostBook(book) {
	const providers = [...book.providers.values()].map((row) => ({
		...row,
		models: [...row.models],
	}));
	return {
		providers,
		usd: providers.reduce((sum, row) => sum + row.usd, 0),
		subscriptionTheoreticalUsd: providers.reduce((sum, row) => sum + row.theoreticalUsd, 0),
		meteredMessages: providers.reduce((sum, row) => sum + (["subscription", "free"].includes(row.mode) ? 0 : row.messages), 0),
		subscriptionMessages: providers.reduce((sum, row) => sum + (["subscription", "free"].includes(row.mode) ? row.messages : 0), 0),
		missingCostMessages: providers.reduce((sum, row) => sum + row.missingCostMessages, 0),
		auxiliaryCalls: providers.reduce((sum, row) => sum + row.auxiliaryCalls, 0),
		costSource: book.source,
	};
}

/** 兼容回退：从当前上下文汇总全部 provider；正常情况优先读取完整会话账本。 */
function contextCostBreakdown(conv, cfg) {
	const book = newCostBook("context-fallback");
	for (const m of Array.isArray(conv?.messages) ? conv.messages : []) {
		if (m?.role !== "assistant" || !m.provider) continue;
		addCost(book, m.provider, m.model, billingProfile(m.provider, m.model, cfg), Number(m.usageCost), "message");
	}
	return finalizeCostBook(book);
}

const sessionFileCache = new Map();

/** 用 conversationId 在 pi 会话目录中定位完整 JSONL 账本；只缓存路径，不缓存金额。 */
function findSessionFile(conversationId) {
	const id = String(conversationId ?? "").trim();
	if (!id || !/^[A-Za-z0-9_-]{6,128}$/.test(id)) return null;
	const cached = sessionFileCache.get(id);
	if (cached && existsSync(cached)) return cached;
	const root = join(agentDir(), "sessions");
	if (!existsSync(root)) return null;
	const suffix = `_${id}.jsonl`;
	let best = null;
	let bestMtime = -1;
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
			let mtime = 0;
			try {
				mtime = statSync(full).mtimeMs;
			} catch {
				/* 能读就用，mtime 只是重复 id 时的择优依据。 */
			}
			if (mtime >= bestMtime) {
				best = full;
				bestMtime = mtime;
			}
		}
	}
	if (best) sessionFileCache.set(id, best);
	return best;
}

function usageTotal(usage) {
	const n = Number(usage?.cost?.total);
	return Number.isFinite(n) ? n : null;
}

/**
 * 从完整会话 JSONL 的当前分支累计指定 provider 的真实已结算 pi 成本。
 * - 当前分支：从文件最后一个 leaf 沿 parentId 回溯，避免把废弃分支也算进去；
 * - 压缩前消息仍在账本祖先链里，所以不会因上下文压缩归零；
 * - compaction / branch_summary / 带 usage 的工具摘要也是 API 调用，按当时选中的 provider 计入；
 * - JSONL 解析后只使用 provider、父子关系和 usage.cost.total，不存储或广播消息正文。
 */
function fullSessionCostBreakdown(conv, cfg) {
	if (!conv?.conversationId) return null;
	const file = findSessionFile(conv?.conversationId);
	if (!file) return null;
	let rows;
	try {
		rows = readFileSync(file, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return null;
	}
	const entries = rows.filter((e) => e?.type !== "session" && typeof e?.id === "string");
	if (!entries.length) return null;
	const byId = new Map(entries.map((e) => [e.id, e]));
	const branch = [];
	const seen = new Set();
	let cur = entries[entries.length - 1];
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		branch.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : null;
	}
	branch.reverse();

	let activeProvider = null;
	let activeModel = null;
	const book = newCostBook("session-ledger");
	for (const entry of branch) {
		if (entry.type === "model_change" && typeof entry.provider === "string") {
			activeProvider = entry.provider;
			activeModel = entry.modelId ?? entry.model ?? null;
			continue;
		}
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const provider = entry.message.provider ?? activeProvider;
			const model = entry.message.model ?? activeModel;
			if (!provider) continue;
			addCost(book, provider, model, billingProfile(provider, model, cfg), usageTotal(entry.message.usage), "message");
			continue;
		}
		const hasAuxUsage =
			entry.type === "usage" ||
			entry.type === "compaction" ||
			entry.type === "branch_summary" ||
			(entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.usage);
		if (!hasAuxUsage) continue;
		const provider = entry.provider ?? activeProvider;
		const model = entry.modelId ?? entry.model ?? activeModel;
		if (!provider) continue;
		const usage = entry.usage ?? entry.message?.usage;
		addCost(book, provider, model, billingProfile(provider, model, cfg), usageTotal(usage), "auxiliary");
	}
	return finalizeCostBook(book);
}

async function fetchUsage(cfg, proxy, auth) {
	const res = await httpGet(
		USAGE_URL,
		{
			Authorization: `Bearer ${auth.access}`,
			"ChatGPT-Account-ID": auth.accountId,
			originator: "pi",
			Accept: "application/json",
		},
		proxy,
	);
	if (res.status === 401) throw new Error("凭证已过期（HTTP 401）——请在 pi 里重新登录 Codex");
	if (res.status === 403) throw new Error("账号/地区不被允许（HTTP 403）——检查代理出口地区");
	if (res.status !== 200) throw new Error(`HTTP ${res.status}：${res.body.slice(0, 200)}`);
	let data;
	try {
		data = JSON.parse(res.body);
	} catch {
		throw new Error("响应不是 JSON（可能被代理/网关拦截）");
	}
	return data;
}

/** 汇率：设置 fixed 直接用；live 走 12 小时缓存的实时抓取，失败退缓存再退兜底。 */
async function getFx(cfg, proxy, storage) {
	if (cfg.rateSource === "fixed") {
		const rate = Number(cfg.fixedRate) || FX_FALLBACK;
		return { rate, source: "fixed", at: Date.now(), stale: false };
	}
	const cached = storage.get("fx", null);
	const fresh = cached && Date.now() - Number(cached.at ?? 0) < FX_TTL_MS;
	if (fresh) return { rate: cached.rate, source: cached.source ?? "live", at: cached.at, stale: false };
	try {
		const res = await httpGet(FX_URL, { Accept: "application/json" }, proxy, 15_000);
		if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
		const rate = Number(JSON.parse(res.body)?.rates?.CNY);
		if (!Number.isFinite(rate) || rate <= 0) throw new Error("未解析到 CNY 汇率");
		const next = { rate, source: "live", at: Date.now() };
		storage.set("fx", next);
		return { ...next, stale: false };
	} catch (err) {
		if (cached?.rate) return { rate: cached.rate, source: cached.source ?? "live", at: cached.at, stale: true };
		return { rate: FX_FALLBACK, source: "fallback", at: Date.now(), stale: true, error: String(err?.message ?? err) };
	}
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 底部状态栏摘要（官方 bottombar 槽位用；文案与 client/entry.mjs 的 barText 保持一致）
// ---------------------------------------------------------------------------

function barPct(n) {
	return Number.isFinite(n) ? `${Math.round(n)}%` : "–";
}

/** 秒 → 5h / 每周 / Nh 这类窗口标签。 */
function barWindowLabel(win) {
	const sec = Number(win?.windowSeconds);
	if (!Number.isFinite(sec) || sec <= 0) return "窗口";
	if (sec >= 7 * 86400 - 60) return "每周";
	if (Math.abs(sec - 18000) < 300) return "5h";
	const h = sec / 3600;
	return h >= 1 ? `${Math.round(h)}h` : `${Math.round(sec / 60)}m`;
}

/** 一行摘要：订阅 → 窗口百分比；无额度 adapter 的订阅 → provider 名；按量 → 人民币成本。 */
function barText(state) {
	if (!state || state.kind === "loading") return "⚡ …";
	if (state.kind === "error") return "⚡ 额度获取失败";
	if (state.kind === "cost") return `⚡ ¥${Number(state.cny || 0).toFixed(2)}`;
	const provider = state.provider || state.model?.provider || "订阅";
	const bits = [];
	for (const w of [state.primary, state.secondary]) {
		if (!w) continue;
		bits.push(`${barWindowLabel(w)} ${barPct(w.usedPercent)}`);
	}
	if (state.resets > 0) bits.push(`${state.resets} reset`);
	if (!bits.length) return `⚡ ${provider}`;
	return `⚡ ${provider} · ${bits.join(" · ")}`;
}

/** 悬停提示：比状态栏一行字更详细（不包含任何凭证）。 */
function barHint(state) {
	if (!state) return "订阅额度 / 成本";
	if (state.kind === "error") return `订阅额度获取失败：${state.message}`;
	if (state.kind === "cost") {
		const rate = Number(state.rate);
		const rateText = Number.isFinite(rate) ? `（1 USD = ${rate.toFixed(4)} CNY` + (state.rateSource ? `，来源 ${state.rateSource}` : "") + "）" : "";
		return `本会话计费估算 ≈ $${Number(state.usd || 0).toFixed(4)} ${rateText}`;
	}
	const provider = state.provider || state.model?.provider || "订阅";
	if (state.quotaAvailable === false) {
		return `${provider} · 已识别为订阅（无内置额度 adapter），已排除理论目录价`;
	}
	const parts = [];
	for (const w of [state.primary, state.secondary]) {
		if (!w) continue;
		const left = Number.isFinite(w.resetAfterSeconds) ? `重置 ${Math.max(0, Math.round(w.resetAfterSeconds / 60))}m` : "";
		parts.push(`${barWindowLabel(w)} 已用 ${barPct(w.usedPercent)}${left ? " · " + left : ""}`);
	}
	if (state.plan) parts.push(`计划 ${state.plan}`);
	if (state.resets > 0) parts.push(`可用 reset ${state.resets}`);
	return parts.length ? `${provider} | ${parts.join(" | ")}` : `${provider} 订阅额度`;
}

/** 供单元测试直接验证识别逻辑；生产代码走 export default。 */
export { billingProfile, barText, barHint };

export default {
	activate(host) {
		let cfg = host.getSettings?.() ?? {};
		let timer = null;
		let inflight = false;
		let pendingRefreshReason = null;
		/** undici 全局 dispatcher 是否已配置（null = 未尝试）。 */
		let dispatcherReady = null;
		let lastState = { kind: "loading", at: Date.now(), statusBar: true };
		/** 宿主是否支持官方 bottombar 槽位（manifest.ui 里申报了 codex-usage:bar）。 */
		const slotBarSupported = typeof host.ui?.update === "function";

		/** 把摘要写进官方 bottombar 槽位（0.90.0+）。失败只记日志，不影响主流程。 */
		function syncBarSlot(state) {
			if (!slotBarSupported) return;
			try {
				const text = barText(state);
				host.ui.update("bar", {
					// 只设 label：宿主对 kind=badge 的条目会把 badge 再渲染成一个嵌套 span，
					// 两个字段同时给同一串字就会显示两遍。
					label: text,
					badge: "",
					hint: barHint(state),
					hidden: state.statusBar === false,
				});
			} catch (err) {
				host.log?.("bottombar 更新失败：", String(err?.message ?? err));
			}
		}

		/** 统一附加客户端需要的设置项（状态栏注入开关等），再广播。 */
		function push(state) {
			lastState = {
				...state,
				mode: state.mode ?? cfg.mode,
				statusBar: cfg.statusBar !== false,
				hideNativeCost: cfg.hideNativeCost !== false,
				// 宿主支持官方 bottombar 槽位时，状态栏摘要由宿主渲染（下面 syncBarSlot），
				// 客户端就不再用 DOM 注入 —— 后者在 0.90.0 会被状态栏溢出裁掉。
				slotBar: slotBarSupported,
				serviceProxy: process.env.HTTPS_PROXY || process.env.https_proxy || null,
				dispatcherReady,
				refreshSec: Math.min(Math.max(Number(cfg.refreshSec) || 60, 15), 3600),
			};
			syncBarSlot(lastState);
			host.broadcast({ state: lastState });
		}

		function errorState(message, model) {
			return { kind: "error", at: Date.now(), message, model, mode: cfg.mode };
		}

		async function refresh(reason) {
			// 模型切换发生在一次旧刷新尚未结束时，不能丢掉新模型的刷新请求。
			if (inflight) {
				pendingRefreshReason = reason;
				return;
			}
			inflight = true;
			try {
				const conv = host.getActiveConversation?.() ?? null;
				const model = pickModel(conv);
				const proxy = resolveProxy(cfg);
				const auth = readCodexAuth();
				const modelChanged =
					model?.provider !== lastState?.model?.provider || model?.model !== lastState?.model?.model;

				const selectedProvider = model?.provider ?? null;
				const selectedModel = model?.model ?? null;
				const selectedProfile = billingProfile(selectedProvider, selectedModel, cfg);
				const autoMode = selectedProfile.mode;
				const selectedBillingMode =
					cfg.mode === "codex" || cfg.mode === "subscription"
						? "subscription"
						: cfg.mode === "cost"
							? "metered"
							: autoMode;

				// 无论当前模型是哪种计费方式，都先构建完整会话账本：订阅页面也要能说明
				// 排除了多少目录价，按量页面则展示所有 provider 的真实/估算成本拆分。
				const fx = await getFx(cfg, proxy, host.storage);
				const cost = fullSessionCostBreakdown(conv, cfg) ?? contextCostBreakdown(conv, cfg);
				const providers = cost.providers.map((row) => ({
					...row,
					cny: row.usd * fx.rate,
					theoreticalCny: row.theoreticalUsd * fx.rate,
				}));
				const costSummary = {
					selectedProvider,
					selectedBillingMode,
					selectedBillingSource: selectedProfile.source,
					selectedBillingConfidence: selectedProfile.confidence,
					selectedBillingNote: selectedProfile.note || "",
					providers,
					usd: cost.usd,
					cny: cost.usd * fx.rate,
					subscriptionTheoreticalUsd: cost.subscriptionTheoreticalUsd,
					subscriptionTheoreticalCny: cost.subscriptionTheoreticalUsd * fx.rate,
					meteredMessages: cost.meteredMessages,
					auxiliaryCalls: cost.auxiliaryCalls,
					costSource: cost.costSource,
					subscriptionMessagesExcluded: cost.subscriptionMessages,
					missingCostMessages: cost.missingCostMessages,
					rate: fx.rate,
					rateSource: fx.source,
					rateAt: fx.at,
					rateStale: Boolean(fx.stale),
					rateError: fx.error ?? null,
					totalMessages: Number(conv?.stats?.totalMessages) || 0,
				};

				// 选择模型的瞬间先清掉旧数字；网络查询完成后再填入真实额度。
				if (modelChanged) push({ kind: "loading", at: Date.now(), mode: cfg.mode, reason: "model-change", model });

				if (selectedBillingMode === "subscription") {
					// Codex 是首个内置订阅 adapter；其他订阅仍能正确排除理论 API 价，
					// 但没有统一额度 API 时只显示“已识别为订阅”。
					if (selectedProvider !== CODEX_PROVIDER) {
						push({
							kind: "subscription",
							at: Date.now(),
							mode: cfg.mode,
							reason,
							model,
							provider: selectedProvider,
							quotaAvailable: false,
							message: "已按订阅模式统计；该 provider 暂无内置额度查询适配器",
							...costSummary,
						});
						return;
					}
					if (!auth) {
						push(errorState("未找到 openai-codex 凭证（<agentDir>/auth.json）——请先在 pi 里登录", model));
						return;
					}
					const expired = auth.expires > 0 && Date.now() > auth.expires;
					try {
						const usage = await fetchUsage(cfg, proxy, auth);
						const rl = usage?.rate_limit ?? {};
						push({
							kind: "subscription",
							adapter: "codex",
							quotaAvailable: true,
							provider: CODEX_PROVIDER,
							at: Date.now(),
							mode: cfg.mode,
							reason,
							model,
							plan: usage?.plan_type ?? null,
							email: maskEmail(usage?.email),
							limitReached: Boolean(rl.limit_reached),
							allowed: rl.allowed !== false,
							primary: normWindow(rl.primary_window),
							secondary: normWindow(rl.secondary_window),
							resets: Number(usage?.rate_limit_reset_credits?.available_count) || 0,
							expired,
							...costSummary,
						});
					} catch (err) {
						host.log("usage fetch failed:", String(err?.message ?? err));
						push(errorState(String(err?.message ?? err), model));
					}
					return;
				}

				push({
					kind: "cost",
					at: Date.now(),
					mode: cfg.mode,
					reason,
					model,
					...costSummary,
				});
			} finally {
				inflight = false;
				const queued = pendingRefreshReason;
				pendingRefreshReason = null;
				if (queued) queueMicrotask(() => void refresh(queued));
			}
		}

		/** 把 pi 的 httpProxy 注入服务进程环境。
		 *
		 * pi SDK 的 Codex/OpenAI 请求只认进程环境变量（https_proxy / all_proxy，见
		 * 其 getProxyForUrl），而 pi-web-ui 服务自身不会读 pi 的 settings.json ——
		 * 不注入就会出现「大模型 API 出错，正在自动重试：fetch failed」
		 * （国内直连 chatgpt.com 必失败）。只在环境里没有代理时注入，不覆盖用户设置。 */
		function inheritProxyEnv() {
			if (cfg.inheritProxy === false) return;
			if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) return;
			const proxy = resolveProxy({ proxy: "" });
			if (!proxy) return;
			process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxy;
			process.env.HTTPS_PROXY = proxy;
			// 本机服务 / 浏览器回连不走代理，避免 localhost:8787 被代理返回 502。
			const noProxy = new Set(String(process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((x) => x.trim()).filter(Boolean));
			for (const hostName of ["localhost", "127.0.0.1", "::1"]) noProxy.add(hostName);
			process.env.NO_PROXY = [...noProxy].join(",");
			process.env.no_proxy = process.env.NO_PROXY;
			host.log(`已为服务进程注入代理（Codex 等请求将走 ${proxy}）`);
		}

		/** 走 fetch 的请求靠 undici 全局 dispatcher，光设环境变量不够；
		 *  这里加载 pi SDK 的 http-dispatcher 并配置（EnvHttpProxyAgent 读 env，
		 *  自动 bypass localhost）。任何一步失败只记日志，不影响主进程。 */
		async function configureDispatcher() {
			if (cfg.inheritProxy === false) return;
			try {
				const { pathToFileURL } = await import("node:url");
				// pi-web-ui 的 bin 路径 = <pkgRoot>/bin/pi-web-ui.mjs，据此定位 pi SDK
				// （不用 createRequire：在服务进程里解析失败过）
				const entry = process.argv[1] || "";
				const pkgRoot = entry ? dirname(dirname(entry)) : process.cwd();
				const candidates = [
					join(pkgRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"),
					join(pkgRoot, "../@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"),
					join(pkgRoot, "../../@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"),
				];
				let loaded = null;
				for (const p of candidates) {
					if (!existsSync(p)) continue;
					loaded = await import(pathToFileURL(p).href);
					break;
				}
				if (!loaded) throw new Error("未找到 pi SDK 的 http-dispatcher.js");
				if (typeof loaded.configureHttpDispatcher !== "function") throw new Error("找不到 configureHttpDispatcher");
				loaded.configureHttpDispatcher();
				dispatcherReady = true;
				host.log("已配置 undici 全局 dispatcher（EnvHttpProxyAgent）");
			} catch (err) {
				dispatcherReady = false;
				host.log("配置 dispatcher 跳过：", String(err?.message ?? err));
			}
		}

		function restartTimer() {
			if (timer) clearInterval(timer);
			const sec = Math.min(Math.max(Number(cfg.refreshSec) || 60, 15), 3600);
			timer = setInterval(() => void refresh("timer"), sec * 1000);
			// 定时器不该拖住进程退出
			timer.unref?.();
		}

		const offMessage = host.onMessage((payload) => {
			if (payload?.action === "refresh") void refresh("client");
			else if (payload?.action === "hello") push(lastState);
		});
		const offAttach = host.onAttach((clientId) => {
			void refresh("attach");
			host.sendTo?.(clientId, { state: lastState });
		});
		// 宿主在 setModel() 成功后会立即发出此事件；无需等下一轮回复或刷新周期。
		const offConv = host.onConversationChanged(() => void refresh("conversation"));
		// pi-web-ui 0.95.0 的 host.models 只有 list()，尚无 onChange；
		// 模型切换由 setModel 后的 notifyConversationChanged → onConversationChanged 覆盖。
		// 未来版本若新增 onChange，此订阅自动生效。
		const offModels = host.models?.onChange?.(() => void refresh("model"));
		const offRun = host.onRunEvent((ev) => {
			if (ev?.type === "run_end" || ev?.type === "message") void refresh("run");
		});
		const offSettings = host.onSettingsChanged((next) => {
			cfg = next ?? {};
			restartTimer();
			void refresh("settings");
		});

		restartTimer();
		inheritProxyEnv();
		void configureDispatcher().then(() => refresh("activate"));
		host.log("activated; mode=", cfg.mode, "rateSource=", cfg.rateSource);

		return () => {
			if (timer) clearInterval(timer);
			offMessage?.();
			offAttach?.();
			offConv?.();
			offModels?.();
			offRun?.();
			offSettings?.();
			host.log("deactivated");
		};
	},
};

/** 邮箱只保留首尾，避免明文外泄到前端存储。 */
function maskEmail(email) {
	const s = String(email ?? "");
	const at = s.indexOf("@");
	if (at <= 0) return null;
	return `${s.slice(0, 2)}***${s.slice(at)}`;
}
