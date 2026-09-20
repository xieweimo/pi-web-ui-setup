/**
 * quick-ask —— 通过插件宿主的 llm.complete 执行孤立、无工具、无历史的一次性问答。
 */
import { randomUUID } from "node:crypto";

const MAX_QUESTION_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 40_000;
const JOB_TIMEOUT_MS = 90_000;
const jobs = new Map();

function activeModel(host) {
	const model = host.getActiveConversation?.()?.activeModel;
	if (!model?.provider || !model?.model) return null;
	return `${model.provider}/${model.model}`;
}

function publicJob(job) {
	return {
		id: job.id,
		model: job.model,
		question: job.question,
		running: job.running,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		output: job.output,
		error: job.error,
	};
}

export default {
	activate(host) {
		host.route("GET", "/model", (_req, res) => {
			res.json({ ok: true, model: activeModel(host) });
		});

		host.route("GET", "/models", async (_req, res) => {
			const current = activeModel(host);
			const raw = await host.models.list();
			const models = [...new Set((Array.isArray(raw) ? raw : []).map((item) => {
				const id = String(item?.id ?? "").trim();
				const provider = String(item?.provider ?? "").trim();
				return id.includes("/") ? id : provider && id ? `${provider}/${id}` : id;
			}).filter((id) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(id)))].sort();
			if (current && !models.includes(current)) models.unshift(current);
			res.json({ ok: true, current, models });
		});

		host.route("POST", "/ask", (req, res) => {
			const text = String(req.body?.text ?? "").trim();
			const model = String(req.body?.model ?? activeModel(host) ?? "").trim();
			const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
			if (!text) return res.status(400).json({ ok: false, error: "问题不能为空" });
			if (text.length > MAX_QUESTION_CHARS) return res.status(400).json({ ok: false, error: `问题不能超过 ${MAX_QUESTION_CHARS} 个字符` });
			if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model)) {
				return res.status(400).json({ ok: false, error: "当前没有可用模型，请先在主对话选择模型" });
			}

			const job = {
				id: randomUUID(), model, question: text, running: true, startedAt: Date.now(), finishedAt: 0,
				output: "", error: "", cancelled: false,
			};
			jobs.set(job.id, job);

			const historyText = history.map((turn) => {
				const question = String(turn?.question ?? "").slice(0, 4000);
				const answer = String(turn?.answer ?? "").slice(0, 8000);
				return `用户：${question}\n助手：${answer}`;
			}).join("\n\n");
			void host.llm.complete({
				model,
				system: "这是一个独立的临时问答，不是编程任务。请给出内容充实、解释清楚的回答：先直接回答核心问题，再补充必要的原因、步骤或例子；除非用户明确要求简短，否则不要只给一句结论。不要调用工具，也不要修改文件。可参考下方临时对话历史保持上下文。",
				prompt: historyText ? `临时对话历史：\n${historyText}\n\n用户的新问题：${text}` : text,
				maxChars: MAX_OUTPUT_CHARS,
				timeoutMs: JOB_TIMEOUT_MS,
			}).then((result) => {
				if (job.cancelled) return;
				job.running = false;
				job.finishedAt = Date.now();
				if (result?.ok) job.output = String(result.text ?? "").slice(-MAX_OUTPUT_CHARS);
				else job.error = String(result?.error ?? "临时问答失败");
			}).catch((err) => {
				if (job.cancelled) return;
				job.running = false;
				job.finishedAt = Date.now();
				job.error = String(err?.message ?? err);
			});

			return res.json({ ok: true, job: publicJob(job) });
		});

		host.route("GET", "/job", (req, res) => {
			const job = jobs.get(String(req.query?.id ?? ""));
			if (!job) return res.status(404).json({ ok: false, error: "临时问答已关闭或不存在" });
			return res.json({ ok: true, job: publicJob(job) });
		});

		host.route("POST", "/stop", (req, res) => {
			const job = jobs.get(String(req.body?.id ?? ""));
			if (!job) return res.status(404).json({ ok: false, error: "临时问答不存在" });
			job.cancelled = true;
			job.running = false;
			job.finishedAt = Date.now();
			job.error = "临时问答已停止。";
			return res.json({ ok: true });
		});

		return () => {
			for (const job of jobs.values()) job.cancelled = true;
			jobs.clear();
		};
	},
};
