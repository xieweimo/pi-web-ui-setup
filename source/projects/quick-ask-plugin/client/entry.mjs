/** 独立临时问答浮层：不依赖主应用 React 状态，也不会发送主对话消息。 */
const ID = "quick-ask";
const API = `/plugins-api/${ID}`;
const ROOT_ID = "quick-ask-overlay";
const STYLE_ID = "quick-ask-style";
let registered = false;
let poll = null;
let currentJob = null;
let conversation = [];

function host() { return window.__piWebUiHost ?? null; }
function notify(text) { host()?.notifyAction?.({ text, actions: [] }); }
async function api(path, method = "GET", body) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
	if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}
function esc(text) { const el = document.createElement("div"); el.textContent = text ?? ""; return el.innerHTML; }

function addStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style"); style.id = STYLE_ID;
	style.textContent = `
#${ROOT_ID}{position:fixed;inset:0;z-index:10000;background:#0008;display:grid;place-items:center;padding:20px}
#${ROOT_ID} .qa{width:min(760px,100%);height:min(720px,88vh);display:flex;flex-direction:column;background:var(--bg,#111118);color:var(--text,#ececf4);border:1px solid var(--border,#373744);border-radius:14px;box-shadow:0 24px 70px #0009;overflow:hidden;font:13px/1.6 system-ui,sans-serif}
#${ROOT_ID} header{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--border,#373744)}
#${ROOT_ID} h2{font-size:15px;margin:0;flex:1} #${ROOT_ID} .qa-model{font:11px system-ui;color:inherit;background:var(--bg-elev1,#20202a);border:1px solid var(--border,#444);border-radius:6px;padding:5px 7px;max-width:48%}
#${ROOT_ID} button{font:inherit;color:inherit;background:var(--bg-elev1,#20202a);border:1px solid var(--border,#444);border-radius:7px;padding:5px 10px;cursor:pointer} #${ROOT_ID} button:hover{border-color:var(--accent,#8b5cf6)} #${ROOT_ID} button.primary{background:var(--accent,#7c5cff);border-color:transparent;color:white} #${ROOT_ID} button:disabled{opacity:.55;cursor:default}
#${ROOT_ID} .qa-log{flex:1;overflow:auto;padding:16px;white-space:pre-wrap;word-break:break-word;background:color-mix(in srgb,var(--bg,#111118) 90%,#000)}
#${ROOT_ID} .qa-empty{opacity:.6} #${ROOT_ID} .qa-error{color:#f87171;margin-top:12px} #${ROOT_ID} .qa-form{padding:12px 16px;border-top:1px solid var(--border,#373744);display:grid;gap:8px}
#${ROOT_ID} textarea{box-sizing:border-box;width:100%;min-height:82px;resize:vertical;font:inherit;color:inherit;background:var(--bg-elev1,#1a1a22);border:1px solid var(--border,#444);border-radius:8px;padding:9px} #${ROOT_ID} .qa-actions{display:flex;justify-content:space-between;align-items:center;gap:8px} #${ROOT_ID} .qa-note{font-size:11px;opacity:.6}
`;
	document.head.appendChild(style);
}
function close() {
	clearInterval(poll); poll = null; currentJob = null; conversation = [];
	document.getElementById(ROOT_ID)?.remove();
}
function render(job, error = "") {
	const root = document.getElementById(ROOT_ID); if (!root) return;
	const log = root.querySelector(".qa-log"); const send = root.querySelector(".qa-send"); const stop = root.querySelector(".qa-stop");
	if (log) {
		const oldTurns = conversation.map((turn) => `<div style="margin:0 0 10px;padding:9px 11px;border-radius:8px;background:var(--bg-elev1,#1a1a22)"><strong>你：</strong>${esc(turn.question)}</div><div style="margin:0 0 18px"><strong>回答：</strong>${esc(turn.answer)}</div>`).join("");
		const current = job
			? `<div style="margin:0 0 10px;padding:9px 11px;border-radius:8px;background:var(--bg-elev1,#1a1a22)"><strong>你：</strong>${esc(job.question ?? "")}</div><div style="margin:0 0 18px"><strong>回答：</strong>${job.output ? esc(job.output) : '<span class="qa-empty">正在思考…</span>'}${job.error ? `<div class="qa-error">${esc(job.error)}</div>` : ""}</div>`
			: "";
		log.innerHTML = oldTurns || current || error ? `${oldTurns}${current}${error ? `<div class="qa-error">${esc(error)}</div>` : ""}` : '<span class="qa-empty">输入问题后开始临时问答。</span>';
	}
	if (send) send.disabled = Boolean(job?.running);
	if (stop) { stop.hidden = !job?.running; stop.disabled = !job?.running; }
	if (log) log.scrollTop = log.scrollHeight;
}
async function refreshModel(root) {
	const select = root.querySelector(".qa-model");
	try {
		const { current, models } = await api("/models");
		select.replaceChildren(...models.map((model) => {
			const option = document.createElement("option"); option.value = model; option.textContent = model; return option;
		}));
		select.value = current || models[0] || "";
		root.dataset.model = select.value;
		select.onchange = () => { root.dataset.model = select.value; };
		if (!select.value) { const option = document.createElement("option"); option.textContent = "没有可用模型"; select.append(option); }
	}
	catch { select.replaceChildren(new Option("无法读取模型", "")); root.dataset.model = ""; }
}
function startPolling() {
	clearInterval(poll);
	poll = setInterval(async () => {
		if (!currentJob) return;
		try {
			const { job } = await api(`/job?id=${encodeURIComponent(currentJob)}`);
			if (!job.running) {
				clearInterval(poll); poll = null;
				conversation.push({ question: job.question ?? "", answer: job.output || job.error || "（没有返回内容）" });
				currentJob = null;
				render(null);
			} else render(job);
		}
		catch (err) { clearInterval(poll); poll = null; currentJob = null; render(null, err.message); }
	}, 500);
}
function open() {
	if (document.getElementById(ROOT_ID)) return;
	addStyle();
	const root = document.createElement("div"); root.id = ROOT_ID;
	root.innerHTML = `<section class="qa" role="dialog" aria-modal="true" aria-label="临时问问"><header><h2>💬 临时问问</h2><select class="qa-model" title="选择临时问答模型"><option>读取模型…</option></select><button class="qa-close" title="关闭">✕</button></header><div class="qa-log"><span class="qa-empty">这是独立的临时对话：不会读取或写入当前任务会话，也不能调用工具修改文件。</span></div><form class="qa-form"><textarea class="qa-input" autofocus placeholder="临时问一句…（Enter 发送，Shift+Enter 换行）"></textarea><div class="qa-actions"><span class="qa-note">结束后不保存历史记录</span><span><button type="button" class="qa-stop" hidden>停止</button><button class="primary qa-send" type="submit">发送</button></span></div></form></section>`;
	document.body.appendChild(root); void refreshModel(root);
	root.querySelector(".qa-close").onclick = close;
	root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
	root.querySelector(".qa-input").addEventListener("keydown", (e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); root.querySelector("form").requestSubmit(); } });
	root.querySelector(".qa-stop").onclick = async () => { if (currentJob) { try { await api("/stop", "POST", { id: currentJob }); } catch (err) { notify(`停止失败：${err.message}`); } } };
	root.querySelector("form").onsubmit = async (e) => {
		e.preventDefault(); const text = root.querySelector(".qa-input").value.trim(); const model = root.dataset.model;
		if (!text) return; if (!model) return render(null, "请先在主对话选择模型。");
		try { const { job } = await api("/ask", "POST", { text, model, history: conversation }); currentJob = job.id; root.querySelector(".qa-input").value = ""; render(job); startPolling(); }
		catch (err) { render(null, err.message); }
	};
	root.querySelector(".qa-input").focus();
}
function register() {
	if (registered) return;
	// 让插件继续显示在原生视图 tab 区，但在捕获阶段接管点击并直接打开浮层，
	// 避免切到一个还要二次点击的中转页面。
	document.addEventListener("click", (event) => {
		if (document.getElementById(ROOT_ID)) return;
		const button = event.target?.closest?.("button");
		if (!button) return;
		const text = String(button.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!text.includes("临时问问") && !text.includes("Quick Ask")) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		open();
	}, true);
	registered = true;
}
register();
export default {
	mount(container) {
		// 宿主会预挂载插件视图；保持空白，实际入口由上方 tab 点击接管。
		container.replaceChildren();
		register();
		return () => {};
	},
};
