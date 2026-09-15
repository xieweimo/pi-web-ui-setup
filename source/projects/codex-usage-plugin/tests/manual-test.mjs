/**
 * codex-usage 插件手工测试：用 mock host 直接跑服务端入口，验证两条数据线。
 *
 * 用法：node projects/codex-usage-plugin/tests/manual-test.mjs
 * 说明：会真实请求 ChatGPT 用量接口（只读，不消耗额度）与汇率接口；
 *      凭证从 <agentDir>/auth.json 读取，本脚本不打印 token。
 */
import plugin from "../index.mjs";

const settings = {
	mode: "auto",
	rateSource: "live",
	fixedRate: 7.2,
	refreshSec: 60,
	statusBar: true,
	proxy: "",
};

function makeHost(provider) {
	const seen = [];
	const host = {
		log: (...a) => console.log("[plugin]", ...a),
		getSettings: () => ({ ...settings }),
		onMessage: () => () => {},
		onAttach: () => () => {},
		onConversationChanged: () => () => {},
		onRunEvent: () => () => {},
		onSettingsChanged: () => () => {},
		sendTo: () => {},
		broadcast: (p) => seen.push(p.state),
		getActiveConversation: () => ({
			messages: provider
				? [{ role: "assistant", provider, model: provider === "openai-codex" ? "gpt-5-codex" : "claude-sonnet-4" }]
				: [],
			stats: { cost: 1.2345, totalMessages: 7, tokens: {} },
		}),
		storage: { get: (_k, f) => f, set: () => {} },
	};
	return { host, seen };
}

async function run(label, provider, patch = {}) {
	Object.assign(settings, patch);
	const { host, seen } = makeHost(provider);
	const cleanup = plugin.activate(host);
	await new Promise((r) => setTimeout(r, 6000));
	cleanup();
	const state = seen[seen.length - 1];
	console.log(`\n===== ${label} =====`);
	console.log(JSON.stringify(state, null, 2));
	return state;
}

const codex = await run("订阅（openai-codex）", "openai-codex");
if (codex?.kind !== "codex") throw new Error("期望 kind=codex，实际 " + codex?.kind);
if (!codex.primary && !codex.secondary) throw new Error("没有拿到用量窗口");

const cost = await run("按量计费（anthropic）", "anthropic");
if (cost?.kind !== "cost") throw new Error("期望 kind=cost，实际 " + cost?.kind);
if (!(cost.cny > 0)) throw new Error("人民币金额异常：" + cost.cny);

const fixed = await run("固定汇率", "anthropic", { rateSource: "fixed", fixedRate: 7.2 });
if (Math.abs(fixed.cny - cost.usd * 7.2) > 1e-6) throw new Error("固定汇率计算错误");

console.log("\n✓ 全部通过");
