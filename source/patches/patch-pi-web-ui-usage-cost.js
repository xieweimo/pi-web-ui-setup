#!/usr/bin/env node
/**
 * 为 pi-web-ui 插件会话快照补充 assistant 消息的 usageCost。
 *
 * 原因：官方插件 API 仅提供会话总 cost，无法剔除同一会话内
 * openai-codex（ChatGPT 订阅）的理论 API 成本。此补丁只暴露
 * usage.cost.total 这个数值，不暴露凭证、原始消息或任何内容。
 *
 * 此脚本幂等；由 pi-web-ui-launcher.ps1 在服务启动前执行，以便
 * npm 升级后自动重打补丁。
 */
const fs = require("fs");
const path = require("path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const target = locateWebUiFile("dist", "server", "serialize.js");
if (!target || !fs.existsSync(target)) {
  console.error("✗ 未找到 pi-web-ui 的 dist/server/serialize.js（便携 install.json 与 npm 全局目录都没有）");
  process.exit(1);
}
const needle = `                timestamp: m.timestamp,\n                model: m.model,`;
const replacement = `                timestamp: m.timestamp,\n                // 仅给插件做按 provider 成本统计；不包含任何消息内容或凭证。\n                usageCost: typeof m.usage?.cost?.total === "number" ? m.usage.cost.total : null,\n                model: m.model,`;

if (!fs.existsSync(target)) {
  console.error(`✗ 找不到 pi-web-ui 序列化文件：${target}`);
  process.exit(1);
}
const source = fs.readFileSync(target, "utf8");if (source.includes("usageCost: typeof m.usage?.cost?.total")) {
  console.log("✓ usageCost 补丁已存在");
  process.exit(0);
}
if (!source.includes(needle)) {
  console.error("✗ pi-web-ui 版本的目标代码已变化，未应用 usageCost 补丁");
  process.exit(2);
}
fs.writeFileSync(target, source.replace(needle, replacement), "utf8");
console.log("✓ 已应用 pi-web-ui assistant usageCost 补丁");
