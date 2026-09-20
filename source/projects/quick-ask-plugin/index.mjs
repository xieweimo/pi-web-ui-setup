/**
 * quick-ask —— 独立临时问答服务端。
 *
 * 每次提问启动 `pi --no-session --no-tools --print`：
 * - `--no-session` 不创建/续写任何 JSONL 会话；
 * - `--no-tools` 不允许读写文件或执行命令；
 * - 当前模型仅作为一次性参数传入，主任务运行时完全不受影响。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_QUESTION_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 40_000;
const JOB_TIMEOUT_MS = 5 * 60_000;
const jobs = new Map();

function piCommand() {
	if (process.platform === "win32") {
		const npmDir = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm");
		const cli = join(npmDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		// 不经 cmd.exe：避免用户问题中的 &、引号等字符被 shell 当成命令执行。
		if (existsSync(cli)) return { file: process.execPath, prefix: [cli] };
	}
	return { file: "pi", prefix: [] };
}

function stopChild(job) {
	try { job.child?.kill(); } catch { /* 已退出 */ }
}

function activeModel(host) {
	const model = host.getActiveConversation?.()?.activeModel;
	if (!model?.provider || !model?.model) return null;
	return `${model.provider}/${model.model}`;
}

function publicJob(job) {
	return {
		id: job.id,
		model: job.model,
		running: job.running,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		output: job.output,
		error: job.error,
	};
}

function append(job, text, isError = false) {
	const key = isError ? "error" : "output";
	job[key] = `${job[key]}${String(text)}`.slice(-MAX_OUTPUT_CHARS);
}

export default {
	activate(host) {
		host.route("GET", "/model", (_req, res) => {
			// 与其他插件接口保持一致；客户端 api() 会校验 ok。
			res.json({ ok: true, model: activeModel(host) });
		});

		host.route("POST", "/ask", (req, res) => {
			const text = String(req.body?.text ?? "").trim();
			const model = String(req.body?.model ?? activeModel(host) ?? "").trim();
			if (!text) return res.status(400).json({ ok: false, error: "问题不能为空" });
			if (text.length > MAX_QUESTION_CHARS) return res.status(400).json({ ok: false, error: `问题不能超过 ${MAX_QUESTION_CHARS} 个字符` });
			if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model)) {
				return res.status(400).json({ ok: false, error: "当前没有可用模型，请先在主对话选择模型" });
			}

			const job = {
				id: randomUUID(), model, running: true, startedAt: Date.now(), finishedAt: 0,
				output: "", error: "", child: null, timer: null,
			};
			jobs.set(job.id, job);
			const command = piCommand();
			const prompt = `这是一个独立的临时问答，不是编程任务。请直接、简洁地回答用户问题；不要调用工具、不要修改任何文件。\n\n用户问题：${text}`;
			try {
				job.child = spawn(command.file, [...command.prefix, "--no-session", "--no-tools", "--model", model, "--print", prompt], {
					cwd: process.cwd(), windowsHide: true, shell: false,
				});
				job.child.stdout?.on("data", (chunk) => append(job, chunk));
				job.child.stderr?.on("data", (chunk) => append(job, chunk, true));
				job.child.on("error", (err) => append(job, err?.message ?? String(err), true));
				job.child.on("close", (code) => {
					clearTimeout(job.timer);
					job.running = false;
					job.finishedAt = Date.now();
					if (code !== 0 && !job.error) job.error = `临时问答退出码：${code}`;
					job.child = null;
				});
				job.timer = setTimeout(() => {
					append(job, "临时问答超时，已停止。", true);
					stopChild(job);
				}, JOB_TIMEOUT_MS);
				job.timer.unref?.();
				return res.json({ ok: true, job: publicJob(job) });
			} catch (err) {
				jobs.delete(job.id);
				return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
			}
		});

		host.route("GET", "/job", (req, res) => {
			const job = jobs.get(String(req.query?.id ?? ""));
			if (!job) return res.status(404).json({ ok: false, error: "临时问答已关闭或不存在" });
			return res.json({ ok: true, job: publicJob(job) });
		});

		host.route("POST", "/stop", (req, res) => {
			const job = jobs.get(String(req.body?.id ?? ""));
			if (!job) return res.status(404).json({ ok: false, error: "临时问答不存在" });
			stopChild(job);
			return res.json({ ok: true });
		});

		return () => {
			for (const job of jobs.values()) {
				clearTimeout(job.timer);
				stopChild(job);
			}
			jobs.clear();
		};
	},
};
