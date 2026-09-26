#!/usr/bin/env node
/** 微信通道：不向外部聊天泄露 pi 内部 marker，并按微信用户隔离无头会话。 */
const fs = require("node:fs");
const path = require("node:path");
const { findWebUiRoot } = require("../scripts/pi-web-ui-locate.js");
const marker = "wechat-ilink-safe-reply-v1";
const root = findWebUiRoot();
const file = root && path.join(path.dirname(root), ".pi-web", "plugins", "wechat-ilink", "index.mjs");
// 标准安装的插件位于 ~/.pi-web，不在 npm 包目录中。
const fallback = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi-web", "plugins", "wechat-ilink", "index.mjs");
const target = file && fs.existsSync(file) ? file : fallback;
if (!fs.existsSync(target)) throw new Error(`找不到微信通道插件：${target}`);
let text = fs.readFileSync(target, "utf8");
if (!text.includes(marker)) {
  const oldFn = `function assistantTextOf(msg) {\n\tif (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return "";\n\treturn msg.content\n\t\t.filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())\n\t\t.map((b) => b.text)\n\t\t.join("\\n");\n}`;
  const newFn = `function assistantTextOf(msg) {\n\tif (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return "";\n\t// ${marker}: marker 是本地 UI 控制协议，绝不能转发到外部聊天。\n\treturn msg.content\n\t\t.filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())\n\t\t.map((b) => b.text)\n\t\t.join("\\n")\n\t\t.replace(/\\[\\[(?:plan|todo|conv|notify):[^\\]]*\\]\\]/g, "")\n\t\t.replace(/\\n{3,}/g, "\\n\\n")\n\t\t.trim();\n}`;
  if (!text.includes(oldFn)) {
    const re = /function assistantTextOf\(msg\) \{[\s\S]*?\n\}/;
    if (!re.test(text)) throw new Error("assistantTextOf 锚点不匹配");
    text = text.replace(re, newFn);
  } else text = text.replace(oldFn, newFn);
  const oldReq = 'const req = { text: `[${label}] ${text}`, accountId: "wx" };';
  const newReq = `const peerKey = Buffer.from(peer, "utf8").toString("base64url");\n\t\t\tconst req = { text: \`[\${label}] \${text}\`, accountId: \`wx_\${peerKey}\` }; // ${marker}: 每位微信用户独立无头会话。`;
  if (!text.includes(oldReq)) throw new Error("drivePeer 锚点不匹配");
  text = text.replace(oldReq, newReq);
  fs.writeFileSync(target, text, "utf8");
}
console.log(`✓ 微信通道安全回包补丁已应用：${target}`);
