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
async function watchdog(port, path, method = "GET") {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
	const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
	if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}
function safeId(value) {
	return String(value).replace(/[^A-Za-z0-9._-]/g, "");
}
function injectStyle(doc) {
	if (doc.getElementById(STYLE_ID)) return;
	const el = doc.createElement("style");
	el.id = STYLE_ID;
	el.textContent = `
.rc{padding:20px;font:13px/1.6 system-ui;max-width:1020px}
.rc h2{margin:0;font-size:17px}
.rc-lead{margin:5px 0 16px;opacity:.75}
.rc-env{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;margin-bottom:10px;border:1px solid var(--border,#444);border-radius:9px;background:var(--bg-elev1,#191b22)}
.rc-env.dev{border-color:#d97706;background:#451a032c}
.rc-env strong{font-size:12px}.rc-env small{opacity:.75}
.rc-warn{margin-bottom:10px;padding:10px 12px;border:1px solid #b45309;border-radius:9px;background:#451a0340;color:#fcd34d;font-size:12px}
.rc-status{display:grid;gap:6px;padding:10px 12px;margin-bottom:14px;border:1px solid var(--border,#444);border-radius:9px}
.rc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rc-dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:none}
.rc-dot.ok{background:#22c55e}.rc-dot.bad{background:#ef4444}.rc-dot.busy{background:#f59e0b}
.rc-port{opacity:.6;font-size:12px}
.rc-panels{display:grid;grid-template-columns:minmax(240px,.75fr) minmax(420px,1.6fr);gap:12px}
@media(max-width:820px){.rc-panels{grid-template-columns:1fr}}
.rc-panel{padding:14px;border:1px solid var(--border,#444);border-radius:10px;background:var(--bg-elev1,#191b22)}
.rc-panel.dev{border-color:#a16207}
.rc-tag{display:inline-block;margin-bottom:8px;padding:2px 7px;border-radius:999px;background:#2563eb26;color:#93c5fd;font-size:11px;font-weight:700}
.rc-panel.dev>.rc-tag{background:#d9770626;color:#fcd34d}
.rc-panel h3{margin:0 0 6px;font-size:14px}
.rc-panel>p{margin:0 0 11px;opacity:.78}
.rc-table{width:100%;border-collapse:collapse;margin:10px 0 14px;font-size:12px}
.rc-table th,.rc-table td{padding:5px 7px;border-bottom:1px solid var(--border,#3a3f4b);text-align:left;vertical-align:top}
.rc-table th{opacity:.7;font-weight:600}
.rc-table td.yes{color:#4ade80}.rc-table td.no{opacity:.55}
.rc-service-list{display:grid;gap:10px}
.rc-service{padding:12px;border:1px solid var(--border,#444);border-left:3px solid var(--accent,#7c5cff);border-radius:8px;background:var(--bg,#111318)}
.rc-service.unowned{border-left-color:#f59e0b}
.rc-service-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.rc-service h4{margin:0;font-size:13.5px}
.rc-service .rc-sub{margin:3px 0 8px;opacity:.72;font-size:12px}
.rc-badge{font-size:10.5px;padding:1px 7px;border-radius:999px;background:#374151;color:#d1d5db;white-space:nowrap}
.rc-badge.ok{background:#14532d;color:#bbf7d0}
.rc-badge.bad{background:#7f1d1d;color:#fecaca}
.rc-badge.warn{background:#78350f;color:#fde68a}
.rc-impact{display:grid;gap:2px;margin:0 0 9px;font-size:12px}
.rc-impact div{display:flex;gap:6px}
.rc-impact .k{flex:none;width:64px;opacity:.6}
.rc-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.rc button{font:inherit;padding:6px 11px;border-radius:7px;border:1px solid var(--border,#555);background:var(--bg-elev2,#222631);color:inherit;cursor:pointer}
.rc button:hover:not(:disabled){border-color:var(--accent,#8b5cf6)}
.rc button.primary{background:var(--accent,#7c5cff);border-color:transparent;color:#fff}
.rc button.warning{border-color:#d97706;color:#fcd34d}
.rc button.danger{color:#fca5a5}
.rc button:disabled{opacity:.5;cursor:default}
.rc-note{margin-top:7px;font-size:11.5px;opacity:.62}
.rc-msg{margin-top:12px;font-size:12px;opacity:.9}
.rc-msg.error{color:#f87171}
.rc-msg.busy{color:#fcd34d}
`;
	doc.head.appendChild(el);
}

/** 每个服务“什么时候该重启它”的说明。 */
function whenToUse(service) {
	if (service.kind === "frontend") return "改了 vite.config.ts、前端页面卡死、样式/依赖改了但没热更新时";
	if (service.kind === "backend") return "改了 server/**、插件或依赖后 node --watch 没生效，或后端接口/WebSocket 卡死时";
	return "该服务异常或改了它的启动配置时";
}
function restartScope(service) {
	if (service.kind === "frontend") return "只重启浏览器开发页面与 HMR 服务；后端进程、会话与正在跑的任务都不动";
	if (service.kind === "backend") return "只重启 API、WebSocket、会话与插件后端；Vite 前端进程和已打开的页面都不动";
	return "只重启这一项服务，其他服务不动";
}

export default {
	mount(container) {
		const doc = container.ownerDocument;
		injectStyle(doc);
		container.innerHTML = `
<div class="rc">
	<h2>🔄 连接与服务控制</h2>
	<div class="rc-lead">同一个面板同时服务日常使用和代码开发。每项操作都写清会重启什么、不会动什么。</div>
	<div class="rc-env" data-role="env"><div><strong data-role="env-title">检测运行环境…</strong><br><small data-role="env-detail"></small></div><small data-role="phase"></small></div>
	<div class="rc-warn" data-role="warn" hidden></div>
	<div class="rc-status" data-role="status"><div class="rc-row"><span class="rc-dot"></span><span>读取服务状态…</span></div></div>
	<div class="rc-panels">
		<section class="rc-panel">
			<span class="rc-tag">用户推荐使用</span>
			<h3>页面出问题先看这里</h3>
			<p>页面显示错乱、提示断连、改了界面想重新加载时用。</p>
			<div class="rc-actions"><button type="button" class="primary" data-global="reload">刷新并重新连接</button></div>
			<div class="rc-note">只重新加载当前浏览器页面并重建 WebSocket。不会停任何进程，也不影响其他已打开的页面。</div>
		</section>
		<section class="rc-panel dev">
			<span class="rc-tag">开发者 / AI 改代码推荐使用</span>
			<h3>按需要重启哪一层</h3>
			<p>改前端保存后通常自动热更新，改后端保存后 <code>node --watch</code> 会自动重启。只有它们没生效、或进程卡死时才手动重启。</p>
			<div class="rc-actions"><button type="button" class="warning" data-global="restart">完整重启全部服务</button></div>
			<div class="rc-note">完整重启＝先停掉下面全部受管进程，再各自启动一个新的。浏览器页面会在恢复后自动刷新。</div>
			<table class="rc-table">
				<thead><tr><th>操作</th><th>前端</th><th>后端</th><th>当前页面</th></tr></thead>
				<tbody data-role="matrix"></tbody>
			</table>
			<div class="rc-service-list" data-role="services"></div>
		</section>
	</div>
	<div class="rc-msg" data-role="msg"></div>
</div>`;

		const $ = (selector) => container.querySelector(selector);
		let watchdogPort = 8790;
		let state = null;
		let busy = false;

		function setMessage(value, error = false, busyMessage = false) {
			const msg = $('[data-role="msg"]');
			if (!msg) return;
			msg.className = `rc-msg${error ? " error" : busyMessage ? " busy" : ""}`;
			msg.textContent = value;
		}
		function normalizedServices(next) {
			if (Array.isArray(next?.services)) return next.services;
			return [{
				id: "main", label: next?.profile === "development" ? "开发环境" : "网页服务", kind: "service",
				description: "当前 restart descriptor 登记的服务", servicePort: next?.servicePort,
				healthy: Boolean(next?.serviceHealthy), phase: next?.phase, pid: next?.pid,
				actions: (next?.actions || ["restart"]).filter((item) => item !== "reload"), lastError: next?.lastError,
			}];
		}
		function renderMatrix(services) {
			const body = $('[data-role="matrix"]');
			if (!body) return;
			body.replaceChildren();
			const front = services.find((item) => item.kind === "frontend");
			const back = services.find((item) => item.kind === "backend");
			// 只列出当前环境真的存在的层次：正式版没有 Vite，就不再显示「重启前端」这一行。
			const rows = [["刷新并重新连接", "不动", "不动", "重新加载"]];
			if (front) rows.push([`重启 ${front.label}`, "重启", "不动", "自动刷新"]);
			if (back) rows.push([`重启 ${back.label}`, "不动", "重启", "WebSocket 自动重连"]);
			rows.push([
				services.length > 1 ? "完整重启全部服务" : "完整重启",
				front ? "重启" : "—",
				back ? "重启" : "重启",
				"恢复后自动刷新",
			]);
			for (const [name, f, b, page] of rows) {
				const tr = doc.createElement("tr");
				const cells = [name, f, b, page];
				cells.forEach((text, index) => {
					const td = doc.createElement("td");
					td.textContent = text;
					if (index > 0) td.className = /重启|重新加载/.test(text) ? "yes" : "no";
					tr.appendChild(td);
				});
				body.appendChild(tr);
			}
		}
		function renderServices(services) {
			const host = $('[data-role="services"]');
			if (!host) return;
			host.replaceChildren();
			for (const service of services) {
				const id = safeId(service.id);
				const card = doc.createElement("div");
				card.className = `rc-service${service.unowned ? " unowned" : ""}`;

				const head = doc.createElement("div"); head.className = "rc-service-head";
				const title = doc.createElement("h4");
				title.textContent = `${service.label}${service.servicePort ? ` · 127.0.0.1:${service.servicePort}` : ""}`;
				const badge = doc.createElement("span");
				const badgeState = service.unowned ? "warn" : service.healthy ? "ok" : "bad";
				badge.className = `rc-badge ${badgeState}`;
				const downText = service.phase === "starting" ? "启动中" : service.phase === "failed" ? "异常退出" : "已停止";
				badge.textContent = service.unowned ? "非本守护管理" : service.healthy ? `运行中${service.pid ? ` · PID ${service.pid}` : ""}` : downText;
				head.append(title, badge);

				const sub = doc.createElement("p"); sub.className = "rc-sub";
				sub.textContent = service.description || "";

				const impact = doc.createElement("div"); impact.className = "rc-impact";
				const others = services.filter((item) => item.id !== service.id)
					.map((item) => `${item.label}${item.servicePort ? ` :${item.servicePort}` : ""}`).join("、");
				for (const [key, text] of [
					["重启范围", restartScope(service)],
					["不动", others || "其他服务（当前环境只登记了这一项）"],
					["何时用", whenToUse(service)],
				]) {
					const line = doc.createElement("div");
					const k = doc.createElement("span"); k.className = "k"; k.textContent = key;
					const v = doc.createElement("span"); v.textContent = text;
					line.append(k, v);
					impact.appendChild(line);
				}

				const actions = doc.createElement("div"); actions.className = "rc-actions";
				const supported = new Set(service.actions || ["restart"]);
				const specs = [
					["restart", service.unowned ? `接管并重启 ${service.label}` : `重启 ${service.label}`, service.unowned ? "warning" : "primary"],
					["start", `启动 ${service.label}`, ""],
					["stop", `停止 ${service.label}`, "danger"],
				];
				for (const [action, label, cls] of specs) {
					if (!supported.has(action)) continue;
					const button = doc.createElement("button");
					button.type = "button"; button.textContent = label; button.className = cls;
					button.dataset.service = id; button.dataset.action = action;
					button.title = action === "restart" ? restartScope(service) : action === "start" ? `启动 ${service.label}，不影响其他服务` : `停止 ${service.label}（其他服务继续运行）`;
					button.disabled = busy || (action === "start" ? service.healthy : action === "stop" ? !service.healthy : false);
					actions.appendChild(button);
				}

				card.append(head);
				if (service.description) card.append(sub);
				card.append(impact, actions);
				const tail = service.warning || service.lastError;
				if (tail) {
					const note = doc.createElement("div");
					note.className = "rc-note";
					note.textContent = service.warning ? `⚠ ${service.warning}` : `最近失败：${service.lastError}`;
					card.appendChild(note);
				}
				host.appendChild(card);
			}
		}
		function paint(next) {
			state = next;
			watchdogPort = next?.watchdogPort || watchdogPort;
			busy = Boolean(next?.operation);
			const services = normalizedServices(next);
			const profile = next?.profile === "development" ? "development" : "user";
			$('[data-role="env"]')?.classList.toggle("dev", profile === "development");
			$('[data-role="env-title"]').textContent = profile === "development" ? "DEV · 源码开发环境" : (next?.label || "pi-web-ui 用户环境");
			const managed = next?.managedBy ? ` · 原管理器：${next.managedBy}` : "";
			$('[data-role="env-detail"]').textContent = `${services.map((item) => `${item.label} :${item.servicePort || "?"}`).join(" · ")} · watchdog :${watchdogPort}${managed}`;
			$('[data-role="phase"]').textContent = busy ? `正在${next.operation.action}：${next.operation.targets?.join(", ") || "全部"}` : `总状态：${next?.phase || "未知"}`;

			const warn = $('[data-role="warn"]');
			const warned = services.filter((item) => item.warning);
			if (warn) {
				warn.hidden = warned.length === 0;
				warn.textContent = warned.map((item) => `⚠ ${item.label}：${item.warning}`).join("  ");
			}

			const status = $('[data-role="status"]'); status.replaceChildren();
			for (const service of services) {
				const row = doc.createElement("div"); row.className = "rc-row";
				const dot = doc.createElement("span");
				dot.className = `rc-dot ${busy && next.operation?.targets?.includes(service.id) ? "busy" : service.healthy ? "ok" : "bad"}`;
				const label = doc.createElement("span");
				const stateText = service.healthy ? "运行正常" : service.unowned ? "被其他进程占用" : service.phase === "starting" ? "启动中" : service.phase === "failed" ? "异常退出，可重新启动" : "已停止（可点启动）";
				label.textContent = `${service.label}：${stateText}`;
				const port = doc.createElement("span"); port.className = "rc-port";
				port.textContent = service.servicePort ? `127.0.0.1:${service.servicePort}${service.pid ? ` · 本守护 PID ${service.pid}` : service.foreignPid ? ` · 外部 PID ${service.foreignPid}` : ""}` : "";
				row.append(dot, label, port); status.appendChild(row);
			}
			const wd = doc.createElement("div"); wd.className = "rc-row";
			wd.innerHTML = `<span class="rc-dot ok"></span><span>独立 watchdog：已就绪</span><span class="rc-port">127.0.0.1:${watchdogPort}</span>`;
			status.appendChild(wd);

			renderMatrix(services);
			const allRestart = $('[data-global="restart"]');
			if (allRestart) allRestart.disabled = busy || !services.some((item) => item.actions?.includes("restart"));
			renderServices(services);
			if (next?.lastError && !warned.length) setMessage(`最近一次操作失败：${next.lastError}`, true);
		}
		async function readState() {
			// 首次必须向当前页面所属的后端询问 watchdog 端口；否则开发页会拿默认
			// 8790，误连到同时运行的正式版 watchdog。后端断开后才用已获知的端口直连。
			try { return await api("/state"); }
			catch (backendError) {
				try { return await watchdog(watchdogPort, "/state"); }
				catch { throw backendError; }
			}
		}
		async function refresh() {
			try { paint(await readState()); }
			catch (error) { setMessage(`状态读取失败：${error.message}`, true); }
		}
		async function waitForOperation(options = {}) {
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				try {
					const next = await watchdog(watchdogPort, "/state");
					paint(next);
					if (!next.operation) {
						if (next.lastError) return setMessage(`操作失败：${next.lastError}`, true);
						setMessage("操作完成。", false);
						if (options.reloadWhenDone) location.reload();
						return;
					}
				} catch {}
			}
		}
		async function run(path, message, reloadWhenDone = false) {
			setMessage(message, false, true);
			try {
				await watchdog(watchdogPort, path, "POST");
				await waitForOperation({ reloadWhenDone });
			} catch (error) {
				setMessage(error.message, true);
				void refresh();
			}
		}

		$('[data-global="reload"]')?.addEventListener("click", () => location.reload());
		$('[data-global="restart"]')?.addEventListener("click", () => void run("/restart", "正在完整重启全部受管服务；恢复后会刷新当前页面。", true));
		container.addEventListener("click", (event) => {
			const button = event.target.closest?.("button[data-service][data-action]");
			if (!button) return;
			const service = normalizedServices(state).find((item) => item.id === button.dataset.service);
			if (!service) return;
			const action = button.dataset.action;
			const force = Boolean(service.unowned);
			if (force) {
				const warning = service.warning || `端口 ${service.servicePort} 上的进程不是本 watchdog 启动的。`;
				if (!confirm(`${warning}\n\n仍要继续吗？（可能导致与原管理器双启动或端口占用失败）`)) return;
			} else if (action === "stop" && !confirm(`确定停止 ${service.label} 吗？${restartScope(service)}。`)) {
				return;
			}
			const query = force ? "?force=1" : "";
			const verb = action === "restart" ? "重启" : action === "start" ? "启动" : "停止";
			const reloadWhenDone = action === "restart" && service.kind === "frontend";
			void run(
				`/services/${encodeURIComponent(service.id)}/${action}${query}`,
				force ? `已请求接管并${verb} ${service.label}；其他服务不受影响。` : `正在${verb} ${service.label}；其他服务不受影响。`,
				reloadWhenDone,
			);
		});

		void refresh();
		timer = setInterval(() => { if (!busy) void refresh(); }, 3000);
		return () => { clearInterval(timer); timer = null; doc.getElementById(STYLE_ID)?.remove(); };
	},
};
