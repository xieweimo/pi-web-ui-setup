/**
 * piwork-tools —— 客户端（顶栏「同步」动作 + 插件视图）
 *
 * 两条入口：
 *   1) 顶栏条目（manifest 的 ui.topbar，action="sync"）被点击时，宿主按需加载本
 *      bundle 并调用本模块顶层注册的 onUiAction 处理器 —— 所以注册写在**模块顶层**，
 *      不能只放在 mount 里（用户可能从没打开过插件视图）。
 *   2) 插件视图（顶栏 ⤴ 同步 tab）：显示最近一次同步的状态与输出，并提供手动触发。
 *
 * 与服务端只有 HTTP 一条通道：POST /plugins-api/piwork-tools/sync 触发，
 * GET /plugins-api/piwork-tools/state 轮询。不碰主应用内部状态。
 */

const PLUGIN_ID = "piwork-tools";
const API_BASE = `/plugins-api/${PLUGIN_ID}`;
const VIEW_ID = `plugin:${PLUGIN_ID}`;
/** 作业运行中的轮询间隔。 */
const POLL_MS = 1500;
const STYLE_ID = "piwork-tools-style";

/** 最近一次拿到的服务端状态。 */
let state = null;
/** 运行中才有的轮询定时器。 */
let pollTimer = null;
/** 视图已挂载时的重绘回调（没打开视图就是 null）。 */
let repaint = null;
/** 顶层注册只做一次。 */
let actionRegistered = false;

function host() {
	try {
		return window.__piWebUiHost ?? null;
	} catch {
		return null;
	}
}

/** 轻量提示：走宿主通知（宿主没注入时退化成一句 console，不报错、不挡流程）。 */
function say(text) {
	try {
		const h = host();
		if (h?.notifyAction) {
			void h.notifyAction({ text, actions: [] });
			return;
		}
	} catch {
		/* 宿主 API 变了就当没有 */
	}
	try {
		console.info("[piwork-tools]", text);
	} catch {
		/* ignore */
	}
}

async function api(path, method = "GET") {
	const res = await fetch(`${API_BASE}${path}`, { method });
	const text = await res.text();
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {
		data = { ok: false, error: text.slice(0, 300) || `HTTP ${res.status}` };
	}
	return data ?? { ok: false, error: `HTTP ${res.status}` };
}

function fmtTime(ms) {
	if (!Number.isFinite(ms) || !ms) return "—";
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusText(s) {
	if (!s) return "尚未同步";
	if (s.running) return `同步中…（${fmtTime(s.startedAt)} 开始）`;
	if (s.error) return `出错：${s.error}`;
	if (s.exitCode === 0) return `上次同步成功（${fmtTime(s.finishedAt)}）`;
	if (s.exitCode === null || s.exitCode === undefined) return "尚无记录";
	return `上次同步失败（退出码 ${s.exitCode}，${fmtTime(s.finishedAt)}）`;
}

function changeLabel(status) {
	if (status.includes("A") || status === "??") return "新增";
	if (status.includes("D")) return "删除";
	if (status.includes("R")) return "重命名";
	if (status.includes("C")) return "复制";
	return "修改";
}

function statusClass(s) {
	if (!s) return "";
	if (s.running) return "run";
	if (s.error) return "err";
	if (s.exitCode === 0) return "ok";
	if (s.exitCode === null || s.exitCode === undefined) return "";
	return "err";
}

function stopPoll() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

/** 轮询到作业结束；结束时给一句话结论。 */
function startPoll(announce = true) {
	if (pollTimer) return;
	pollTimer = setInterval(() => {
		void (async () => {
			const s = await api("/state").catch(() => null);
			if (!s || s.ok === false) return;
			state = s;
			repaint?.(s);
			if (s.running) return;
			stopPoll();
			if (!announce) return;
			state = s;
			if (s.error) say(`同步出错：${s.error}`);
			else if (s.exitCode === 0) say("同步完成：pi-web-ui-setup 已是最新（打包、推送、GitHub 校验一致）");
			else say(`同步未成功（退出码 ${s.exitCode}）——打开 ⤴ 同步视图看输出`);
		})();
	}, POLL_MS);
}

/** 触发一次同步：先 POST，再轮询到结束。 */
async function startSync() {
	if (state?.running) {
		say("同步正在进行中，请等它结束");
		return;
	}
	const r = await api("/sync", "POST").catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
	if (!r?.ok) {
		say(r?.busy ? "同步正在进行中" : `同步启动失败：${r?.error ?? "未知原因"}`);
		return;
	}
	say("已开始同步：打包 → 推送 AIWork / pi-web-ui-setup → GitHub 匿名校验");
	state = r.state ?? state;
	repaint?.(state);
	startPoll();
}

/** 注册顶栏动作处理器（宿主在触发前会按需加载本 bundle，所以顶层注册即可生效）。 */
function registerAction() {
	if (actionRegistered) return;
	const h = host();
	if (!h?.onUiAction) return;
	try {
		h.onUiAction("sync", () => {
			void startSync();
		});
		actionRegistered = true;
	} catch {
		/* 宿主 API 变化：留给视图里的按钮兜底 */
	}
}

registerAction();
// 宿主 API 可能比 bundle 晚一点点就绪：下个宏任务再试一次，仍失败就交给视图按钮。
setTimeout(registerAction, 0);

function injectStyle(doc) {
	if (doc.getElementById(STYLE_ID)) return;
	const el = doc.createElement("style");
	el.id = STYLE_ID;
	el.textContent = `
.pt{max-width:820px;margin:0 auto;font-size:13px;line-height:1.6}
.pt header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.pt h2{margin:0;font-size:15px;display:flex;align-items:center;gap:8px}
.pt .pt-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.85}
.pt .pt-dot{width:8px;height:8px;border-radius:99px;background:#6b7280;display:inline-block}
.pt .pt-status.run .pt-dot{background:#eab308}
.pt .pt-status.ok .pt-dot{background:#22c55e}
.pt .pt-status.err .pt-dot{background:#ef4444}
.pt button{background:var(--bg-elev1,#1a1a22);color:var(--text,#e6e6ef);border:1px solid var(--border,#333);border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit;font-size:12px}
.pt button:hover{border-color:var(--accent,#7c5cff)}
.pt button[disabled]{opacity:.5;cursor:default}
.pt .pt-hint{opacity:.6;margin:2px 0 12px}
.pt .pt-meta{font-size:11.5px;opacity:.65;margin-bottom:10px;display:grid;gap:2px;word-break:break-all}
.pt .pt-changes{border:1px solid var(--border,#333);border-radius:8px;margin:0 0 10px;padding:9px 12px;background:var(--bg-elev1,rgba(255,255,255,.02))}
.pt .pt-changes-title{font-weight:600;margin-bottom:5px}
.pt .pt-change-list{display:grid;gap:3px;max-height:180px;overflow:auto}
.pt .pt-change{display:flex;align-items:baseline;gap:8px;min-width:0}
.pt .pt-change-kind{flex:none;min-width:42px;color:var(--accent,#8b7cff);font-size:11.5px}
.pt .pt-change-path{font-family:var(--mono,ui-monospace,monospace);font-size:11.5px;word-break:break-all}
.pt .pt-change-empty{opacity:.6;font-size:12px}
.pt pre{max-height:46vh;overflow:auto;border:1px solid var(--border,#333);border-radius:8px;padding:10px 12px;background:var(--bg-elev1,rgba(255,255,255,.02));font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0}
`;
	doc.head.appendChild(el);
}

export default {
	mount(container, ctx) {
		const doc = container.ownerDocument;
		injectStyle(doc);

		container.innerHTML = `
<div class="pt">
	<header>
		<h2>⤴ 同步<span class="pt-status"><span class="pt-dot"></span><span class="pt-status-text">读取中…</span></span></h2>
		<button type="button" class="pt-sync">立即同步</button>
	</header>
	<p class="pt-hint">同步 = 重新打包安装包 → 提交并推送 AIWork 与 pi-web-ui-setup → 从 GitHub 匿名校验 SHA256。改完 pi / pi-web-ui 的定制后跑一次，异地机器才能装到最新版。</p>
	<div class="pt-meta">
		<div class="pt-root"></div>
		<div class="pt-cmd"></div>
	</div>
	<section class="pt-changes">
		<div class="pt-changes-title">本次同步改动</div>
		<div class="pt-change-list"><div class="pt-change-empty">尚未开始同步</div></div>
	</section>
	<pre class="pt-out">（还没有输出）</pre>
</div>`;

		const statusEl = container.querySelector(".pt-status");
		const statusTextEl = container.querySelector(".pt-status-text");
		const rootEl = container.querySelector(".pt-root");
		const cmdEl = container.querySelector(".pt-cmd");
		const changesEl = container.querySelector(".pt-change-list");
		const outEl = container.querySelector(".pt-out");
		const btn = container.querySelector(".pt-sync");

		function draw(s) {
			state = s ?? state;
			if (!state) return;
			if (statusEl) statusEl.className = `pt-status ${statusClass(state)}`;
			if (statusTextEl) statusTextEl.textContent = statusText(state);
			if (rootEl) {
				rootEl.textContent = state.root
					? `仓库根：${state.root}`
					: `仓库根：未配置${state.candidates?.length ? `（试过：${state.candidates.join("、")}）` : ""}`;
			}
			if (cmdEl) cmdEl.textContent = `脚本：${state.script ?? ""}`;
			if (changesEl) {
				const changes = Array.isArray(state.changes) ? state.changes : [];
				changesEl.replaceChildren();
				if (!changes.length) {
					const empty = doc.createElement("div");
					empty.className = "pt-change-empty";
					empty.textContent = state.startedAt ? "本次没有需要提交的文件改动" : "尚未开始同步";
					changesEl.appendChild(empty);
				} else {
					for (const change of changes) {
						const row = doc.createElement("div");
						row.className = "pt-change";
						const kind = doc.createElement("span");
						kind.className = "pt-change-kind";
						kind.textContent = changeLabel(String(change.status ?? ""));
						const path = doc.createElement("span");
						path.className = "pt-change-path";
						path.textContent = String(change.path ?? "");
						row.append(kind, path);
						changesEl.appendChild(row);
					}
				}
			}
			if (outEl) outEl.textContent = state.lines?.length ? state.lines.join("\n") : "（还没有输出）";
			if (btn) btn.disabled = Boolean(state.running);
		}

		repaint = draw;
		btn?.addEventListener("click", () => void startSync());

		void (async () => {
			const s = await api("/state").catch(() => null);
			if (s && s.ok !== false) {
				draw(s);
				if (s.running) startPoll(false);
			} else {
				if (statusTextEl) statusTextEl.textContent = "服务端未就绪";
			}
		})();

		// 打开视图时顺手确认一次动作注册（宿主 API 在该时机一定已就绪）。
		registerAction();

		return () => {
			repaint = null;
			stopPoll();
			doc.getElementById(STYLE_ID)?.remove();
		};
	},
};
