/**
 * codex-usage —— 客户端视图（tab 详情卡片 + 底部状态栏摘要注入）
 *
 * 与主应用只有两条通道：ctx.send 上行、ctx.onData 下行（不共享 React 实例）。
 * 状态栏注入是「锦上添花」：pi-web-ui 的 .statusbar 是 React 渲染的，
 * 我们插进去的节点会在重渲染时被冲掉，所以用 MutationObserver 兜底重插；
 * 找不到状态栏就只留 tab 视图，绝不报错影响主应用。
 */

const STYLE_ID = "codex-usage-style";
const BAR_ID = "codex-usage-statusbar";

/** 当前视图 id（与 manifest.id 一致，用于点击状态栏切到本 tab）。 */
const VIEW_ID = "plugin:codex-usage";

/**
 * 前端构建标记：面板会显示它，`data-cu-build` 也会带上。
 * 用来回答“这页面到底跑的是哪一版插件前端”——宿主重启后 epoch 从 0 重来、
 * 页面自动重新 import 插件前端，光看界面是分不出来的。
 */
const CLIENT_BUILD = "per-client-alignment-1";

function esc(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

function pct(n) {
	return Number.isFinite(n) ? `${Math.round(n)}%` : "–";
}

/** 秒 → 2h13m / 6d13h / 45s。 */
function fmtDur(sec) {
	const s = Math.max(0, Math.round(Number(sec) || 0));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60}m`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24}h`;
}

function remainingMs(win) {
	if (!win) return null;
	if (Number.isFinite(win.resetAt)) return win.resetAt - Date.now();
	if (Number.isFinite(win.resetAfterSeconds)) return win.resetAfterSeconds * 1000;
	return null;
}

function windowLabel(win) {
	const sec = Number(win?.windowSeconds);
	if (!Number.isFinite(sec) || sec <= 0) return "窗口";
	if (sec >= 7 * 86400 - 60) return "每周";
	if (Math.abs(sec - 18000) < 300) return "5h";
	const h = sec / 3600;
	return h >= 1 ? `${Math.round(h)}h` : `${Math.round(sec / 60)}m`;
}

function levelClass(used) {
	if (!Number.isFinite(used)) return "";
	if (used >= 90) return "crit";
	if (used >= 70) return "warn";
	return "ok";
}

function money(n, digits = 2) {
	return Number(n || 0).toFixed(digits);
}

function fmtTime(ms) {
	if (!Number.isFinite(ms)) return "";
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** 一行摘要（状态栏用）：订阅 → 窗口百分比；计费 → ¥ 成本。 */
function barText(state, now) {
	if (!state || state.kind === "loading") return "⚡ …";
	if (state.kind === "error") return "⚡ 额度获取失败";
	if (state.kind === "cost") return `⚡ ¥${money(state.cny)}`;
	const bits = [];
	for (const w of [state.primary, state.secondary]) {
		if (!w) continue;
		bits.push(`${windowLabel(w)} ${pct(w.usedPercent)}`);
	}
	if (state.resets > 0) bits.push(`${state.resets} reset`);
	if (!bits.length) return `⚡ ${state.provider || state.model?.provider || "订阅"}`;
	void now;
	return `⚡ ${bits.join(" · ")}`;
}

function barTitle(state) {
	if (!state) return "订阅额度 / 成本";
	if (state.kind === "error") return `订阅额度获取失败：${state.message}`;
	if (state.kind === "cost") {
		const scope = state.costSource === "session-ledger" ? "完整会话账本" : "当前上下文回退";
		return `本会话计费估算 ≈ ¥${money(state.cny)}（${scope} · $${money(state.usd, 4)} · 汇率 ${state.rate}${state.rateStale ? " 缓存" : ""}）`;
	}
	const provider = state.provider || state.model?.provider || "当前 provider";
	const lines = [`${provider} 订阅${state.plan ? `（${state.plan}）` : ""}`];
	for (const w of [state.primary, state.secondary]) {
		if (!w) continue;
		const left = remainingMs(w);
		lines.push(
			`${windowLabel(w)}：已用 ${pct(w.usedPercent)}${left !== null ? `，${fmtDur(left / 1000)} 后重置` : ""}`,
		);
	}
	if (state.resets > 0) lines.push(`可用 reset：${state.resets} 次`);
	if (state.expired) lines.push("凭证已过期，请在 pi 里重新登录");
	return lines.join("\n");
}

/**
 * 纯函数：这份插件状态是不是「本页面这个对话」的。
 * 判据是页面上不依赖插件的原生「消息 N」：宿主重启后活动对话会被重置成“本项目最近一条
 * 会话”，不一定是你眼前的那个，插件按它算出来的成本就不是本对话的（典型表现：额度变 0）。
 * 导出来是为了能离线回归（见 tests/state-alignment.test.mjs）。
 */
export function matchesPageMessages(state, nativeCount) {
	if (!state || state.kind === "loading" || state.kind === "error") return true; // 过渡/错误态不做归属判断
	const reported = Number(state.totalMessages);
	if (!Number.isFinite(reported)) return true;
	if (nativeCount === null || nativeCount === undefined || !Number.isFinite(Number(nativeCount))) return true;
	return reported === Number(nativeCount);
}

function injectStyle(doc) {
	if (doc.getElementById(STYLE_ID)) return;
	const el = doc.createElement("style");
	el.id = STYLE_ID;
	el.textContent = `
.cu{max-width:820px;margin:0 auto;font-size:13px;line-height:1.6}
.cu h2{margin:0;font-size:15px;display:flex;align-items:center;gap:8px}
.cu header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}
.cu .cu-actions{display:flex;align-items:center;gap:8px;font-size:11.5px;opacity:.7}
.cu button{background:var(--bg-elev1,#1a1a22);color:var(--text,#e6e6ef);border:1px solid var(--border,#333);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:11.5px}
.cu button:hover{border-color:var(--accent,#7c5cff)}
.cu .cu-hint{opacity:.6;margin:2px 0 14px}
.cu .cu-cards{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.cu .cu-card{border:1px solid var(--border,#333);border-radius:10px;padding:12px 14px;background:var(--bg-elev1,rgba(255,255,255,.02))}
.cu .cu-card .cu-k{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;opacity:.75}
.cu .cu-card .cu-v{font-size:24px;font-weight:600;margin:2px 0 8px}
.cu .cu-track{height:7px;border-radius:99px;background:rgba(127,127,127,.22);overflow:hidden}
.cu .cu-fill{height:100%;border-radius:99px;background:var(--accent,#7c5cff);transition:width .4s ease}
.cu .cu-fill.warn{background:#eab308}
.cu .cu-fill.crit{background:#ef4444}
.cu .cu-sub{font-size:11.5px;opacity:.6;margin-top:6px}
.cu .cu-big{font-size:30px;font-weight:600}
.cu .cu-err{border:1px solid #b91c1c66;background:#b91c1c1a;border-radius:10px;padding:10px 12px;color:inherit}
.cu .cu-meta{margin-top:14px;font-size:11.5px;opacity:.55;display:grid;gap:2px}
.cu .cu-badge{display:inline-block;border:1px solid var(--border,#444);border-radius:99px;padding:1px 8px;font-size:11px;opacity:.8;margin-left:6px}
#${BAR_ID}{cursor:pointer;display:inline-flex;align-items:center;gap:4px;max-width:38ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${BAR_ID}.crit{color:#ef4444}
#${BAR_ID}.warn{color:#eab308}
@media (max-width:640px){.cu .cu-v{font-size:20px}.cu .cu-big{font-size:24px}}
`;
	doc.head.appendChild(el);
}

/**
 * 状态栏那条摘要为什么容易被“挤没”：
 * 上游的 .status-item / .status-action 只有 display:inline-flex，没有 flex-shrink:0，
 * 而 .statusbar-left 是 flex:1 1 auto + min-width:0 —— 项变多（例如流式回复时宿主会多渲染
 * 一个 working 项）或窗口变窄时，插件那一项就会被压缩到看不见（不是不渲染，是被压扁）。
 * 这里给状态栏各项加一道“不许压缩 / 不许换行”的保险，保证额度那条一直可读。
 */
const BAR_PIN_ID = "codex-usage-bar-pin";
function pinStatusBarItems(doc) {
	if (doc.getElementById(BAR_PIN_ID)) return;
	const el = doc.createElement("style");
	el.id = BAR_PIN_ID;
	el.textContent = `.statusbar .status-item,.statusbar .status-action,.statusbar .status-conn{flex:0 0 auto;white-space:nowrap}`;
	doc.head.appendChild(el);
}

// enabled 插件的 client bundle 会在启动时预加载；不要等用户打开额度面板才加这条规则。
if (typeof document !== "undefined") pinStatusBarItems(document);

export default {
	mount(container, ctx) {
		const doc = container.ownerDocument;
		injectStyle(doc);
		pinStatusBarItems(doc);

		container.innerHTML = `
<div class="cu">
	<header>
		<h2>⚡ 模型额度 / 成本<span class="cu-badge" style="display:none"></span></h2>
		<div class="cu-actions"><span class="cu-updated">—</span><button type="button" class="cu-refresh">刷新</button></div>
	</header>
	<p class="cu-hint">订阅 provider 自动排除理论 API 价；有额度适配器时显示窗口用量。按量 / 积分 provider 从完整会话账本汇总成本，并按实时汇率显示人民币。</p>
	<div class="cu-body"><div class="cu-card">正在获取…</div></div>
	<div class="cu-meta"></div>
</div>`;

		const root = container.querySelector(".cu");
		const bodyEl = root.querySelector(".cu-body");
		const metaEl = root.querySelector(".cu-meta");
		const updatedEl = root.querySelector(".cu-updated");
		const badgeEl = root.querySelector(".cu-badge");
		let state = null;
		/** 定向发给我这个页面的状态（宿主按 clientId 取“本页面打开的对话”）。 */
		let myState = null;
		/** 全局广播那份：官方 bottombar 槽位渲染的就是它。 */
		let globalState = null;
		/** 当前 myState 是否与本页面会话对齐（见 stateMatchesPage）。 */
		let myStateAligned = false;
		/** 按页面隐藏的宿主槽位项（React 重建后会重新捕获）。 */
		let hiddenSlot = null;

		// ---- 状态栏摘要注入 ----
		let barEl = null;
		let barObserver = null;
		/** 被隐藏的原生「$ 累计成本」项（React 重建后会重新捕获）。 */
		let hiddenNative = null;

		function makeBar() {
			const el = doc.createElement("span");
			el.id = BAR_ID;
			el.addEventListener("click", () => {
				try {
					window.__piWebUiHost?.setView?.(VIEW_ID);
				} catch {
					/* 宿主 API 变了就当普通文本 */
				}
			});
			return el;
		}

		/** 原生「 $ 累计成本」项（按 title 匹配中英两种语言）。 */
		function findCostItem() {
			const bar = doc.querySelector(".statusbar");
			if (!bar) return null;
			const items = [...bar.querySelectorAll(".status-item")];
			return items.find((n) => /累计成本|Cumulative cost/i.test(n.getAttribute("title") || "")) ?? null;
		}

		/** 按设置隐藏 / 恢复原生成本项；React 重渲染会重建节点，所以每次同步都重应用。 */
		function syncNativeCost() {
			// 状态还没拿到时不要动：否则会先把原生成本项恢复出来，等状态到又隐藏，看起来就是一闪。
			if (!state) return;
			const item = findCostItem();
			if (!item) return;
			const shouldHide = Boolean(state?.hideNativeCost) && state?.statusBar !== false;
			if (shouldHide) {
				if (item.style.display !== "none") item.style.display = "none";
				hiddenNative = item;
			} else if (item.style.display === "none") {
				// 只恢复我们自己隐藏的那个，不碰其他原因隐藏的
				item.style.display = "";
			}
		}

		function placeBar() {
			const bar = doc.querySelector(".statusbar");
			if (!bar) return false;
			if (!barEl || !barEl.isConnected) {
				barEl = makeBar();
				// 插到「累计成本」项之前，避免被状态栏右侧溢出裁掉
				const anchor = findCostItem();
				if (anchor?.parentElement === bar) {
					const sep = doc.createElement("span");
					sep.className = "status-sep";
					sep.id = `${BAR_ID}-sep`;
					bar.insertBefore(sep, anchor);
					bar.insertBefore(barEl, anchor);
				} else {
					bar.appendChild(barEl);
				}
			}
			return true;
		}

		function removeBar() {
			barEl?.remove();
			doc.getElementById(`${BAR_ID}-sep`)?.remove();
			barEl = null;
		}

		/** 原生状态栏上的「消息 N」——本页面这个会话的真实消息数（不依赖插件任何数据）。 */
		function nativeMessageCount() {
			const bar = doc.querySelector(".statusbar");
			if (!bar) return null;
			const item = [...bar.querySelectorAll(".status-item")].find((n) => /会话消息数/.test(n.getAttribute("title") || ""));
			const m = item ? (item.textContent || "").match(/(\d+)/) : null;
			return m ? Number(m[1]) : null;
		}

		/**
		 * 这份状态是不是「本页面这个对话」的：拿它与原生「消息 N」对齐。
		 *
		 * 为什么必须有这道防线：宿主重启后，每个浏览器的活动对话会被重置成
		 * `SessionManager.continueRecent(cwd)`（本项目最近一条会话），**不一定是你眼前这个**；
		 * 插件按它算出来的成本就不是本对话的 —— 典型表现就是“重启后额度突然变 0”。
		 * 对不上就不采用，保留上一次对齐的值并要求服务端重算。
		 */
		function stateMatchesPage(next, native) {
			return matchesPageMessages(next, native === undefined ? nativeMessageCount() : native);
		}

		let lastRealignAt = 0;
		/** 状态对不上时要求服务端重算（节流，避免抖）。 */
		function requestRealign() {
			const now = Date.now();
			if (now - lastRealignAt < 10_000) return;
			lastRealignAt = now;
			try {
				ctx.send({ action: "refresh" });
			} catch {
				/* ignore */
			}
		}

		/**
		 * 本页面状态与槽位那份状态是否冲突（决定是否接管状态栏）。
		 * 槽位是全局单例，多标签 / 并行对话 / 重启后都可能渲染别的对话的模型与额度。
		 */
		function slotConflicts() {
			if (!myState && !globalState) return false; // 还没数据：先不动宿主槽位
			if (!myStateAligned) return true; // 有数据但与本页面对不上 → 不信任槽位
			if (!globalState) return false;
			return barText(myState) !== barText(globalState);
		}

		/** 宿主槽位里属于本插件的那一项（按我们自己的 hint 文本或 ⚡ 前缀认）。 */
		function findSlotItem() {
			const bar = doc.querySelector(".statusbar");
			if (!bar) return null;
			const hint = globalState ? barTitle(globalState) : null;
			const items = [...bar.querySelectorAll(".status-action,.status-item")];
			return (
				items.find((n) => !n.id && hint && n.getAttribute("title") === hint) ??
				items.find((n) => !n.id && (n.textContent || "").trim().startsWith("⚡")) ??
				null
			);
		}

		/** 冲突时把宿主那项藏掉（只藏我们自己认出来的那个），不冲突时恢复。 */
		function syncSlotVisibility() {
			const item = findSlotItem();
			if (!item) return;
			if (slotConflicts()) {
				if (item.style.display !== "none") {
					item.style.display = "none";
					hiddenSlot = item;
				}
			} else if (item.style.display === "none" && (hiddenSlot === item || !hiddenSlot)) {
				item.style.display = "";
				hiddenSlot = null;
			}
		}

		/** 状态栏上要显示的文字：没对齐时宁可标“同步中”，也不显示别的对话的数字。 */
		function pageBarText() {
			if (!myStateAligned) return "⚡ 同步中…";
			return barText(state);
		}

		function syncBar() {
			// 宿主支持官方 bottombar 槽位（state.slotBar）且与本页面状态一致时，摘要由宿主渲染：
			// 0.90.0 把状态栏改成溢出容器后，插件自己插的节点会被挤到不可见区。
			// 只有两者不一致（本页面的对话不是“最近活跃对话”）才按页面自己接管。
			if (state?.slotBar && !slotConflicts()) {
				removeBar();
				if (hiddenSlot?.isConnected) hiddenSlot.style.display = "";
				hiddenSlot = null;
				syncNativeCost();
				return;
			}
			// 状态还没拿到（初始化 / 切换会话的瞬间）：保持现状，不要把已经显示的那行抹掉。
			// 旧写法是 `if (!state?.statusBar)`，state 为空也会走移除 —— 于是每次状态刷新都会闪一下。
			if (!state) {
				syncNativeCost();
				return;
			}
			// 只有在设置里明确关掉「状态栏显示」时才移除。
			if (state.statusBar === false) {
				removeBar();
				if (hiddenSlot?.isConnected) hiddenSlot.style.display = "";
				hiddenSlot = null;
				syncNativeCost();
				return;
			}
			if (!placeBar()) return;
			syncSlotVisibility();
			syncNativeCost();
			const text = pageBarText();
			if (barEl.textContent !== text) barEl.textContent = text;
			const title = barTitle(state);
			if (barEl.title !== title) barEl.title = title;
			const cls = state.kind === "subscription" ? levelClass(state.primary?.usedPercent) : "";
			if (barEl.className !== cls) barEl.className = cls;
		}

		function watchBar() {
			const bar = doc.querySelector(".statusbar");
			if (!bar || barObserver) return;
			let pending = false;
			barObserver = new MutationObserver(() => {
				if (pending) return;
				pending = true;
				setTimeout(() => {
					pending = false;
					try {
						syncBar();
					} catch {
						/* 注入失败不影响主应用 */
					}
				}, 300);
			});
			barObserver.observe(bar, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["class", "title", "style"],
			});
		}

		// ---- 渲染 ----
		function billingLabel(mode) {
			return ({ subscription: "订阅", metered: "API 按量", prepaid: "预付积分", free: "免费/本地", hybrid: "订阅+超额", unknown: "待确认" })[mode] || mode || "待确认";
		}

		function billingAmount(row) {
			if (row.mode === "subscription") return `目录价 ¥${money(row.theoreticalCny)}（订阅已排除）`;
			if (row.mode === "free") return `目录价 ¥${money(row.theoreticalCny)}（免费，不计费）`;
			if (row.mode === "prepaid") return `积分消耗估算 ¥${money(row.cny)}`;
			if (row.mode === "unknown") return `未确认目录价 ¥${money(row.cny)}`;
			if (row.mode === "hybrid") return `混合计费估算 ¥${money(row.cny)}`;
			return `成本估算 ¥${money(row.cny)} · $${money(row.usd, 4)}`;
		}

		function renderProviderBreakdown(s) {
			const rows = Array.isArray(s.providers) ? s.providers : [];
			if (!rows.length) return "";
			return `<div class="cu-card" style="margin-top:10px">
				<div class="cu-k"><span>本会话 Provider 明细</span><span>${s.costSource === "session-ledger" ? "完整会话账本" : "当前上下文回退"}</span></div>
				${rows
					.map((row) => {
						const detail = [row.billingLabel && row.billingLabel !== row.provider ? row.billingLabel : "", row.billingNote || "", row.baseUrl || ""]
							.filter(Boolean)
							.join(" · ");
						return `<div class="cu-sub" style="padding:4px 0;border-bottom:1px solid rgba(127,127,127,.12)">
							<div style="display:flex;justify-content:space-between;gap:12px"><span>${esc(row.provider)} · ${esc(billingLabel(row.mode))}</span><span>${esc(billingAmount(row))}</span></div>
							${detail ? `<div style="opacity:.7">${esc(detail)} · 识别 ${esc(row.billingConfidence || "low")}</div>` : ""}
						</div>`;
					})
					.join("")}
			</div>`;
		}

		function renderSubscription(s) {
			if (!s.quotaAvailable) {
				return `<div class="cu-card">
					<div class="cu-k"><span>${esc(s.provider || s.model?.provider || "当前 provider")} 订阅</span><span>不计入按量成本</span></div>
					<div class="cu-v" style="font-size:18px">已识别为订阅模式</div>
					<div class="cu-sub">${esc(s.message || "该 provider 暂无可读取的额度接口；已排除会话中的理论 API 目录价。")}</div>
				</div>${renderProviderBreakdown(s)}`;
			}
			const cards = [s.primary, s.secondary]
				.filter(Boolean)
				.map((w) => {
					const cls = levelClass(w.usedPercent);
					const left = remainingMs(w);
					return `
	<div class="cu-card">
		<div class="cu-k"><span>${esc(windowLabel(w))} 窗口</span><span>${left !== null ? `${esc(fmtDur(left / 1000))} 后重置` : ""}</span></div>
		<div class="cu-v">${esc(pct(w.usedPercent))}</div>
		<div class="cu-track"><div class="cu-fill ${cls}" style="width:${Math.min(Math.max(w.usedPercent ?? 0, 0), 100)}%"></div></div>
		<div class="cu-sub">窗口长度 ${esc(fmtDur(w.windowSeconds))}${Number.isFinite(w.resetAt) ? ` · 重置于 ${esc(fmtTime(w.resetAt))}` : ""}</div>
	</div>`;
				})
				.join("");
			const resets = s.resets > 0 ? `<div class="cu-sub">可用 banked reset：<b>${s.resets}</b> 次</div>` : "";
			const warn = s.expired ? `<div class="cu-sub" style="color:#eab308">凭证已过期——请重新登录后刷新</div>` : "";
			const reached = s.limitReached ? `<div class="cu-sub" style="color:#ef4444">当前窗口已达上限</div>` : "";
			return `${cards || '<div class="cu-card">接口未返回窗口数据</div>'}${resets}${warn}${reached}${renderProviderBreakdown(s)}`;
		}

		function renderCost(s) {
			const excluded = Number(s.subscriptionMessagesExcluded) || 0;
			const missing = Number(s.missingCostMessages) || 0;
			const auxiliary = Number(s.auxiliaryCalls) || 0;
			const fullLedger = s.costSource === "session-ledger";
			return `
	<div class="cu-card">
		<div class="cu-k"><span>本会话实际 / 估算按量成本</span><span>${fullLedger ? "完整会话账本" : "当前上下文回退"}</span></div>
		<div class="cu-big">¥${esc(money(s.cny))}</div>
		<div class="cu-sub">≈ $${esc(money(s.usd, 4))} · 1 USD = ${esc(s.rate)} CNY · 汇率时间 ${esc(fmtTime(s.rateAt))}${
			s.rateError ? ` · 抓取失败：${esc(s.rateError)}` : ""
		}</div>
		<div class="cu-sub">已纳入 ${esc(s.meteredMessages)} 次按量/积分调用${
			auxiliary ? ` · ${esc(auxiliary)} 次压缩/摘要调用` : ""
		} · 已排除 ${esc(excluded)} 次订阅调用${missing ? ` · ${esc(missing)} 次调用缺少成本字段` : ""}</div>
	</div>${renderProviderBreakdown(s)}`;
		}

		function render(state) {
			if (!state || state.kind === "loading") {
				bodyEl.innerHTML = '<div class="cu-card">正在获取…</div>';
				return;
			}
			if (state.kind === "error") {
				bodyEl.innerHTML = `<div class="cu-err"><b>获取失败</b><div style="margin-top:4px">${esc(state.message)}</div></div>`;
				return;
			}
			bodyEl.innerHTML = state.kind === "subscription" ? renderSubscription(state) : renderCost(state);
		}

		function renderMeta(s) {
			if (!s) return;
			const bits = [];
			if (!myStateAligned) {
				bits.push("⚠ 这份数据还不是本页面会话的（宿主重启后活动对话被重置）——正在重新对齐，已保留上一次对齐的数值");
			}
			if (s.plan) bits.push(`套餐：${s.plan}`);
			if (s.model?.provider) bits.push(`模型：${s.model.provider}${s.model.model ? ` / ${s.model.model}` : ""}`);
			if (s.selectedBillingMode) {
				bits.push(`计费识别：${billingLabel(s.selectedBillingMode)} · ${s.selectedBillingSource || "unknown"} · 置信度 ${s.selectedBillingConfidence || "low"}`);
				if (s.selectedBillingNote) bits.push(`计费提示：${s.selectedBillingNote}`);
			}
			if (s.conversationId) {
				bits.push(
					`快照会话：…${String(s.conversationId).slice(-6)} · 消息 ${Number(s.totalMessages) || 0}` +
						(myState && !slotConflicts() ? "（与底部状态栏同一对话）" : ""),
				);
			}
			bits.push(
				s.serviceProxy
					? `服务进程代理：${s.serviceProxy} · dispatcher ${s.dispatcherReady === true ? "已配置" : s.dispatcherReady === false ? "未配置（fetch 类请求仍会失败）" : "未知"}`
					: `服务进程代理：未设置（Codex 订阅模型会报 fetch failed，详见 docs/codex-usage-插件说明.md）`,
			);
			if (s.reason) bits.push(`触发：${s.reason}`);
			bits.push(`模式：${s.mode ?? "auto"} · 更新于 ${fmtTime(s.at)}`);
			bits.push(`插件前端构建：${CLIENT_BUILD}`);
			metaEl.innerHTML = bits.map((b) => `<div>${esc(b)}</div>`).join("");
		}

		/**
		 * 给面板挂上可断言的数据钩子（自检脚本用它核对
		 * “插件这份快照到底是哪个对话”）。
		 */
		function syncDebugAttrs() {
			root.dataset.cuBuild = CLIENT_BUILD;
			root.dataset.cuPerClient = myState ? "1" : "0";
			root.dataset.cuAligned = myStateAligned ? "1" : "0";
			root.dataset.cuConversation = String(state?.conversationId ?? "");
			root.dataset.cuMessages = String(Number(state?.totalMessages) || 0);
			root.dataset.cuProvider = String(state?.model?.provider ?? state?.provider ?? "");
			root.dataset.cuModel = String(state?.model?.model ?? "");
			root.dataset.cuBarText = pageBarText();
			root.dataset.cuConflict = slotConflicts() ? "1" : "0";
		}

		function apply(next, perClient) {
			if (perClient) {
				const matches = stateMatchesPage(next);
				if (!matches && (myState || myStateAligned)) {
					// 对不上本页面：不采用（避免把别的对话的 0/数字显示出来），保留上一次并对齐。
					requestRealign();
				} else {
					myState = next ?? {};
					myStateAligned = matches;
				}
			} else {
				// 全局广播只当茶位兜底：与本页面会话对不上就不要（它常是别的对话的）。
				globalState = stateMatchesPage(next) ? next ?? {} : globalState;
			}
			// 面板与状态栏都优先用“本页面那份”；没有定向数据时才退回全局广播。
			state = myState ?? globalState ?? {};
			render(state);
			renderMeta(state);
			syncDebugAttrs();
			updatedEl.textContent = `更新于 ${fmtTime(state.at)}`;
			if (badgeEl) {
				badgeEl.style.display = state.plan ? "" : "none";
				badgeEl.textContent = state.plan ?? "";
			}
			try {
				syncBar();
				watchBar();
			} catch {
				/* 状态栏注入是可选项，失败静默 */
			}
		}

		const onRefreshClick = () => ctx.send({ action: "refresh" });
		root.querySelector(".cu-refresh")?.addEventListener("click", onRefreshClick);

		const off = ctx.onData((payload) => {
			if (payload && typeof payload === "object" && "state" in payload) apply(payload.state, payload.perClient === true);
		});

		// 每秒同步一次（倒计时 + 原生项隐藏状态，React 重渲染被冲掉后自动补回）
		const timer = setInterval(() => {
			if (!state) return;
			try {
				syncBar();
			} catch {
				/* ignore */
			}
		}, 1000);

		// 心跳：服务端没有 detach 回调，只能靠“最近有没有消息”判断这个页面是否还活着
		// （并顺带刷新本页面那份状态）。服务重启 / 网络抖动后，页面不需要重新加载
		// 也能自动重新登记；不跳的话就会被当成幽灵清掉，或被别的对话顶掉状态栏。
		const heartbeat = setInterval(() => {
			try {
				ctx.send({ action: "hello" });
			} catch {
				/* ignore */
			}
		}, 45_000);

		ctx.send({ action: "refresh" });

		return () => {
			off?.();
			clearInterval(timer);
			clearInterval(heartbeat);
			barObserver?.disconnect();
			removeBar();
			if (hiddenSlot?.isConnected) hiddenSlot.style.display = "";
			if (hiddenNative?.isConnected) hiddenNative.style.display = "";
			doc.getElementById(STYLE_ID)?.remove();
		};
	},
};
