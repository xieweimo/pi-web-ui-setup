/**
 * reconnect —— 断连恢复视图（独立插件，与「同步」无关）。
 *
 * 两条操作：
 *   - 重新连接：直接刷新本页（WebSocket 会重新握手）；
 *   - 重启网页服务：经插件路由让服务端去 POST 守护进程 8788 的 /restart，再自动刷新。
 * 服务端状态每 3 秒刷新一次；断开时页面本身可能已经连不上，那种场景由前端补丁的浮层兜底。
 */
const PLUGIN_ID = "reconnect";
const API = `/plugins-api/${PLUGIN_ID}`;
const STYLE_ID = "reconnect-style";
let timer = null;

async function api(path, method = "GET") {
	const res = await fetch(`${API}${path}`, { method });
	const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
	if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

function injectStyle(doc) {
	if (doc.getElementById(STYLE_ID)) return;
	const el = doc.createElement("style");
	el.id = STYLE_ID;
	el.textContent = `
.rc{padding:18px 20px;font:13px/1.7 system-ui;max-width:640px}
.rc h2{margin:0 0 10px;font-size:15px}
.rc p{margin:0 0 14px;opacity:.75}
.rc-rows{display:grid;gap:6px;margin:0 0 16px}
.rc-row{display:flex;align-items:center;gap:8px}
.rc-dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:none}
.rc-dot.ok{background:#22c55e}
.rc-dot.bad{background:#ef4444}
.rc-actions{display:flex;gap:8px;flex-wrap:wrap}
.rc button{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid var(--border,#444);background:var(--bg-elev1,#20202a);color:inherit;cursor:pointer}
.rc button:hover{border-color:var(--accent,#8b5cf6)}
.rc button.primary{background:var(--accent,#7c5cff);border-color:transparent;color:#fff}
.rc button:disabled{opacity:.55;cursor:default}
.rc-msg{margin-top:12px;font-size:12px;opacity:.85}
.rc-msg.error{color:#f87171}
`;
	doc.head.appendChild(el);
}

export default {
	mount(container) {
		const doc = container.ownerDocument;
		injectStyle(doc);
		container.innerHTML = `
<div class="rc">
	<h2>🔄 重连</h2>
	<p>只在真正需要时用：页面刷新解决不了断连时，重启网页服务会由本机守护进程重新拉起 8787。</p>
	<div class="rc-rows">
		<div class="rc-row"><span class="rc-dot" data-role="svc"></span><span data-role="svc-text">检查网页服务…</span></div>
		<div class="rc-row"><span class="rc-dot" data-role="wd"></span><span data-role="wd-text">检查重启守护…</span></div>
	</div>
	<div class="rc-actions">
		<button type="button" class="primary" data-act="reconnect">重新连接（刷新本页）</button>
		<button type="button" data-act="restart">重启网页服务</button>
	</div>
	<div class="rc-msg" data-role="msg"></div>
</div>`;

		const dot = (role) => container.querySelector(`.rc-dot[data-role="${role}"]`);
		const text = (role) => container.querySelector(`[data-role="${role}-text"]`);
		const msg = container.querySelector('[data-role="msg"]');
		const restartBtn = container.querySelector('[data-act="restart"]');

		function paint(state) {
			dot("svc")?.classList.toggle("ok", true);
			if (text("svc")) text("svc").textContent = "网页服务：在线（能看到这个页面就说明连上了）";
			const wdOk = Boolean(state?.watchdog);
			dot("wd")?.classList.toggle("ok", wdOk);
			dot("wd")?.classList.toggle("bad", !wdOk);
			if (text("wd")) {
				text("wd").textContent = wdOk
					? "重启守护：已就绪（127.0.0.1:8788）"
					: "重启守护：未运行 —— 关掉本页后重新运行「启动 Pi 网页版」即可拉起";
			}
			if (restartBtn) restartBtn.disabled = !wdOk;
		}

		async function refresh() {
			try {
				paint(await api("/state"));
			} catch (err) {
				dot("svc")?.classList.remove("ok");
				dot("svc")?.classList.add("bad");
				if (text("svc")) text("svc").textContent = `网页服务：不可用（${err.message}）`;
			}
		}

		container.querySelector('[data-act="reconnect"]')?.addEventListener("click", () => location.reload());
		restartBtn?.addEventListener("click", async () => {
			restartBtn.disabled = true;
			if (msg) {
				msg.className = "rc-msg";
				msg.textContent = "已请求重启，服务稍后自动回来…";
			}
			try {
				await api("/restart", "POST");
				setTimeout(() => location.reload(), 2500);
			} catch (err) {
				if (msg) {
					msg.className = "rc-msg error";
					msg.textContent = err.message;
				}
				restartBtn.disabled = false;
			}
		});

		void refresh();
		timer = setInterval(() => void refresh(), 3000);
		return () => {
			clearInterval(timer);
			timer = null;
			doc.getElementById(STYLE_ID)?.remove();
		};
	},
};
