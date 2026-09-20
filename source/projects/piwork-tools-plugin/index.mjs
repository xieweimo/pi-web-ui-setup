/**
 * piwork-tools —— PIwork 工作区工具（服务端入口）
 *
 * 顶栏「同步」按钮的后端：跑一遍 scripts/sync-pi-web-ui-setup.ps1
 * （重新打包 → 提交推送 AIWork 与 pi-web-ui-setup → 从 GitHub 匿名校验），
 * 把过程输出与退出码回传给前端轮询。
 *
 * 为什么放在插件里：插件目录（<dataDir>/plugins/<id>/）与 pi-web-ui 包目录分离，
 * npm 升级 pi-web-ui 不会动它 —— 这正是「补丁会腐烂、插件不会」的那部分。
 *
 * 仓库根从哪来（按优先级）：
 *   1) 插件目录里的 config.json 的 repoRoot（安装器写）
 *   2) 设置面板的 repoRoot（host.getSettings）
 *   3) 环境变量 PIWORK_ROOT
 * 三者都拿不到（或脚本不在）时，接口返回明确错误，前端照原样显示。
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "config.json");
const SCRIPT_REL = join("scripts", "sync-pi-web-ui-setup.ps1");
/** 保留的输出行数（够排查，又不至于把内存和前端撑爆）。 */
const MAX_LINES = 400;
const TAIL_LINES = 80;
/** 整轮同步的墙钟上限：打包 + 两个仓库推送 + 4 次匿名下载校验。 */
const JOB_TIMEOUT_MS = 20 * 60_000;

/** 当前作业状态（单作业：两个同步同时跑会互抢 zip 与 git 索引）。 */
const job = {
	running: false,
	startedAt: 0,
	finishedAt: 0,
	exitCode: null,
	error: null,
	lines: [],
};
/** 正在跑的对话轮次计数（run_start / run_end 配对）。 */
let activeRuns = 0;
let child = null;
let timer = null;
/** activate 时记下宿主，用于作业结束时发通知。 */
let hostRef = null;

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 已配置的仓库根候选（只看配置，不校验脚本是否存在）。 */
function rootCandidates(host) {
	const out = [];
	const cfg = readJson(CONFIG_FILE);
	if (typeof cfg?.repoRoot === "string" && cfg.repoRoot.trim()) out.push(cfg.repoRoot.trim());
	const fromSettings = host?.getSettings?.();
	if (typeof fromSettings?.repoRoot === "string" && fromSettings.repoRoot.trim()) out.push(fromSettings.repoRoot.trim());
	const env = process.env.PIWORK_ROOT;
	if (typeof env === "string" && env.trim()) out.push(env.trim());
	return [...new Set(out)];
}

/** 找到真正含同步脚本的那个根；找不到返回 null。 */
function resolveRoot(host) {
	for (const c of rootCandidates(host)) {
		if (existsSync(join(c, SCRIPT_REL))) return c;
	}
	return null;
}

/** PowerShell 单引号字符串转义。 */
function psQuote(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function pushLines(chunk) {
	// 子进程已被显式切到 UTF-8；这里按 UTF-8 解码，避免 Windows PowerShell
	// 默认 OEM/系统代码页导致中文被 Node 当成 UTF-8 后显示为乱码。
	const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	const clean = text.replace(/\r/g, "");
	for (const line of clean.split("\n")) {
		if (!line.trim()) continue;
		job.lines.push(line.slice(0, 500));
	}
	if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
}

function snapshot(host) {
	return {
		running: job.running,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		exitCode: job.exitCode,
		error: job.error,
		lines: job.lines.slice(-TAIL_LINES),
		root: resolveRoot(host),
		candidates: rootCandidates(host),
		script: SCRIPT_REL,
	};
}

function clearTimer() {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}

function finalize(code, host) {
	clearTimer();
	job.running = false;
	job.finishedAt = Date.now();
	job.exitCode = typeof code === "number" ? code : null;
	child = null;
	const ok = job.exitCode === 0;
	const detail = job.lines.at(-1) ?? "";
	try {
		host?.notify?.(
			ok ? "info" : "error",
			ok ? "同步完成：pi-web-ui-setup 已是最新（打包、推送、GitHub 校验一致）" : `同步未成功（退出码 ${job.exitCode}）：${detail}`,
			ok ? "Sync done: pi-web-ui-setup is up to date." : `Sync failed (exit ${job.exitCode}): ${detail}`,
		);
	} catch {
		/* 通知失败不影响状态本身 */
	}
}

function startJob(host) {
	const root = resolveRoot(host);
	if (!root) {
		const tried = rootCandidates(host);
		return {
			ok: false,
			error: tried.length
				? `这些目录里都没有 ${SCRIPT_REL}：${tried.join("、")}`
				: `还没配置仓库根：请在插件目录的 config.json 里写 {"repoRoot":"<PIwork 仓库路径>"}（安装器会自动写）`,
		};
	}
	job.running = true;
	job.startedAt = Date.now();
	job.finishedAt = 0;
	job.exitCode = null;
	job.error = null;
	job.lines = [];
	try {
		const script = join(root, SCRIPT_REL);
		// Windows PowerShell 5.1 在重定向 stdout 时默认不保证 UTF-8。先显式设置
		// 控制台与管道编码，再调用脚本并原样传递退出码。
		const command = [
			"$utf8 = New-Object System.Text.UTF8Encoding($false)",
			"[Console]::OutputEncoding = $utf8",
			"$OutputEncoding = $utf8",
			`& ${psQuote(script)}`,
			"exit $LASTEXITCODE",
		].join("; ");
		child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
			cwd: root,
			windowsHide: true,
		});
	} catch (err) {
		job.running = false;
		job.error = String(err?.message ?? err);
		return { ok: false, error: job.error };
	}
	// setEncoding 内部会保留跨 chunk 的半个 UTF-8 字符，避免边界处出现 �。
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", pushLines);
	child.stderr?.on("data", pushLines);
	child.on("error", (err) => {
		job.error = String(err?.message ?? err);
	});
	child.on("close", (code) => finalize(code, host));
	timer = setTimeout(() => {
		pushLines(`[超时] 同步超过 ${Math.round(JOB_TIMEOUT_MS / 60000)} 分钟，已终止`);
		try {
			child?.kill();
		} catch {
			/* 已退出 */
		}
	}, JOB_TIMEOUT_MS);
	timer.unref?.();
	return { ok: true, startedAt: job.startedAt, root };
}

export default {
	async activate(host) {
		hostRef = host;

		// 运行中的对话/工具计数：启动器用它判断「页面已关但还有活要干」——
		// 这种情况先不停服，等任务跑完再停，免得把执行到一半的活截断。
		activeRuns = 0;
		const offRunEvent = host.onRunEvent((ev) => {
			const type = String(ev?.type ?? "");
			if (type === "run_start") activeRuns += 1;
			else if (type === "run_end") activeRuns = Math.max(0, activeRuns - 1);
		});

		// 忙不忙：给 launcher 的停服决策用（页面断开后每秒问一次）。
		host.route("GET", "/busy", (req, res) => {
			let streaming = false;
			try {
				streaming = Boolean(host.getActiveConversation?.()?.isStreaming);
			} catch {
				/* 宿主 API 变化：只靠事件计数 */
			}
			res.json({ busy: activeRuns > 0 || streaming, activeRuns, streaming });
		});

		// 状态查询：前端点完按钮就轮询它，直到 running=false。
		host.route("GET", "/state", (req, res) => {
			res.json(snapshot(hostRef));
		});

		// 触发同步。同时只允许一个作业（zip 与 git 索引不容并发）。
		host.route("POST", "/sync", (req, res) => {
			if (job.running) {
				res.status(409).json({ ok: false, busy: true, error: "同步正在进行中，请等它结束", state: snapshot(hostRef) });
				return;
			}
			const started = startJob(hostRef);
			if (!started.ok) {
				res.status(400).json(started);
				return;
			}
			res.json({ ...started, state: snapshot(hostRef) });
		});

		host.log("activated; root =", resolveRoot(host) ?? "(未配置)");
		return () => {
			clearTimer();
			offRunEvent?.();
			activeRuns = 0;
			try {
				child?.kill();
			} catch {
				/* 已退出 */
			}
			child = null;
			hostRef = null;
			host.log("deactivated");
		};
	},
};
