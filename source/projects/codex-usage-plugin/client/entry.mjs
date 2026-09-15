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
	if (!bits.length) return "⚡ Codex";
	void now;
	return `⚡ ${bits.join(" · ")}`;
}

function barTitle(state) {
	if (!state) return "订阅额度 / 成本";
	if (state.kind === "error") return `订阅额度获取失败：${state.message}`;
	if (state.kind === "cost") {
		return `本会话按量模型成本 ≈ ¥${money(state.cny)}（已剔除 ${Number(state.subscriptionMessagesExcluded) || 0} 次 Codex 订阅调用 · $${money(state.usd, 4)} · 汇率 ${state.rate}${state.rateStale ? " 缓存" : ""}）`;
	}
	const lines = [`ChatGPT 订阅额度${state.plan ? `（${state.plan}）` : ""}`];
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

export default {
	mount(container, ctx) {
		const doc = container.ownerDocument;
		injectStyle(doc);

		container.innerHTML = `
<div class="cu">
	<header>
		<h2>⚡ 订阅额度 / 成本<span class="cu-badge" style="display:none"></span></h2>
		<div class="cu-actions"><span class="cu-updated">—</span><button type="button" class="cu-refresh">刷新</button></div>
	</header>
	<p class="cu-hint">Codex 订阅显示 5 小时 / 每周窗口用量与重置倒计时；按量模型仅统计本会话的非订阅调用成本，自动剔除 Codex 理论 API 价。数据源：ChatGPT 用量接口 + 实时汇率。</p>
	<div class="cu-body"><div class="cu-card">正在获取…</div></div>
	<div class="cu-meta"></div>
</div>`;

		const root = container.querySelector(".cu");
		const bodyEl = root.querySelector(".cu-body");
		const metaEl = root.querySelector(".cu-meta");
		const updatedEl = root.querySelector(".cu-updated");
		const badgeEl = root.querySelector(".cu-badge");
		let state = null;

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

		function syncBar() {
			if (!state?.statusBar) {
				removeBar();
				syncNativeCost();
				return;
			}
			if (!placeBar()) return;
			syncNativeCost();
			const text = barText(state);
			if (barEl.textContent !== text) barEl.textContent = text;
			const title = barTitle(state);
			if (barEl.title !== title) barEl.title = title;
			const cls = state.kind === "codex" ? levelClass(state.primary?.usedPercent) : "";
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
		function renderCodex(s) {
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
			const resets =
				s.resets > 0
					? `<div class="cu-sub">可用 banked reset：<b>${s.resets}</b> 次（在 ChatGPT 里兑换）</div>`
					: "";
			const warn = s.expired
				? `<div class="cu-sub" style="color:#eab308">凭证已过期——请在 pi 里重新登录 Codex 后刷新</div>`
				: "";
			const reached = s.limitReached
				? `<div class="cu-sub" style="color:#ef4444">当前窗口已达上限（limit reached）</div>`
				: "";
			return `${cards || '<div class="cu-card">接口未返回窗口数据</div>'}${resets}${warn}${reached}`;
		}

		function renderCost(s) {
			const excluded = Number(s.subscriptionMessagesExcluded) || 0;
			const missing = Number(s.missingCostMessages) || 0;
			return `
	<div class="cu-card">
		<div class="cu-k"><span>本会话按量模型成本</span><span>${s.rateStale ? "汇率来自缓存" : "实时汇率"}</span></div>
		<div class="cu-big">¥${esc(money(s.cny))}</div>
		<div class="cu-sub">≈ $${esc(money(s.usd, 4))} · 1 USD = ${esc(s.rate)} CNY · 汇率时间 ${esc(fmtTime(s.rateAt))}${
			s.rateError ? ` · 抓取失败：${esc(s.rateError)}` : ""
		}</div>
		<div class="cu-sub">已纳入 ${esc(s.meteredMessages)} 次按量调用 · 已剔除 ${esc(excluded)} 次 Codex 订阅调用${
			missing ? ` · ${esc(missing)} 次调用缺少成本字段` : ""
		}</div>
	</div>`;
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
			bodyEl.innerHTML = state.kind === "codex" ? renderCodex(state) : renderCost(state);
		}

		function renderMeta(s) {
			if (!s) return;
			const bits = [];
			if (s.plan) bits.push(`套餐：${s.plan}`);
			if (s.model?.provider) bits.push(`模型：${s.model.provider}${s.model.model ? ` / ${s.model.model}` : ""}`);
			bits.push(
				s.serviceProxy
					? `服务进程代理：${s.serviceProxy} · dispatcher ${s.dispatcherReady === true ? "已配置" : s.dispatcherReady === false ? "未配置（fetch 类请求仍会失败）" : "未知"}`
					: `服务进程代理：未设置（Codex 订阅模型会报 fetch failed，详见 docs/codex-usage-插件说明.md）`,
			);
			if (s.reason) bits.push(`触发：${s.reason}`);
			bits.push(`模式：${s.mode ?? "auto"} · 更新于 ${fmtTime(s.at)}`);
			metaEl.innerHTML = bits.map((b) => `<div>${esc(b)}</div>`).join("");
		}

		function apply(next) {
			state = next ?? {};
			render(state);
			renderMeta(state);
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
			if (payload && typeof payload === "object" && "state" in payload) apply(payload.state);
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

		ctx.send({ action: "refresh" });

		return () => {
			off?.();
			clearInterval(timer);
			barObserver?.disconnect();
			removeBar();
			if (hiddenNative?.isConnected) hiddenNative.style.display = "";
			doc.getElementById(STYLE_ID)?.remove();
		};
	},
};
