/**
 * 「状态必须与本页面会话对齐」回归测试（离线、纯函数）。
 *
 * 背景：宿主重启后，每个浏览器的活动对话被重置成 `SessionManager.continueRecent(cwd)`
 * （本项目最近一条会话），不一定是页面上正在看的那个；插件按它算成本就会显示别的对话的
 * 数字（用户看到的就是“重启后额度变 0”）。客户端现在拿页面原生「消息 N」做对齐校验：
 * 对不上就不采用，保留上一次对齐值并请求重算。
 *
 * 运行：node projects/codex-usage-plugin/tests/state-alignment.test.mjs
 */
import assert from "node:assert/strict";
import { matchesPageMessages } from "../client/entry.mjs";

// 对得上：采纳。
assert.equal(matchesPageMessages({ kind: "cost", totalMessages: 299 }, 299), true);
assert.equal(matchesPageMessages({ kind: "subscription", totalMessages: 0 }, 0), true);

// 对不上：拒绝 —— 这正是「重启后活动对话被重置成空会话」的场景。
assert.equal(matchesPageMessages({ kind: "cost", totalMessages: 0 }, 266), false, "空会话状态不得冒充本页面");
assert.equal(matchesPageMessages({ kind: "cost", totalMessages: 87 }, 299), false, "别的对话的状态不得冒充本页面");

// 缺信息/过渡态：不拦（宁可显示上一份，也不要因为读不到而空转）。
assert.equal(matchesPageMessages({ kind: "loading" }, 299), true);
assert.equal(matchesPageMessages({ kind: "error", message: "HTTP 401" }, 299), true);
assert.equal(matchesPageMessages({ kind: "cost", totalMessages: 5 }, null), true, "读不到原生计数时不拦");
assert.equal(matchesPageMessages({ kind: "cost" }, 5), true, "状态里没有 totalMessages 时不拦");
assert.equal(matchesPageMessages(null, 5), true);

// 原生计数是字符串/数字混用时按数值比较。
assert.equal(matchesPageMessages({ kind: "cost", totalMessages: 12 }, "12"), true);

console.log("✓ 状态–页面会话对齐回归测试通过（重启后不会再把别的对话/空会话显示成本页面的额度）");
