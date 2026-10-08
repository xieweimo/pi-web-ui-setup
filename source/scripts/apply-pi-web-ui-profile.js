#!/usr/bin/env node
/** 根据已安装的 pi / pi-web-ui 版本，选择并安全应用对应补丁 profile。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { findWebUiRoot, packageVersion } = require('./pi-web-ui-locate');
const root = path.resolve(__dirname, '..');
const webRoot = findWebUiRoot();
if (!webRoot) {
  console.error('找不到 pi-web-ui 安装目录：请确认已完成安装，或检查 install.json。');
  process.exit(2);
}
// 版本判定必须与 scripts/check-pi-web-ui-patches.js 一致：**优先自带副本**（服务实际加载的那份），
// 再回落到全局 npm 目录。过去这里只读全局，导致升级后自带副本更新、两份脚本各算一个版本。
const pi = packageVersion('@earendil-works/pi-coding-agent');
const web = packageVersion('pi-web-ui');
if (!pi || !web) {
  console.error(`版本识别失败：pi=${pi} pi-web-ui=${web}`);
  process.exit(2);
}
const dir = path.join(root, 'configs', 'pi-web-ui-profiles');
const profileFile = fs.readdirSync(dir).find(f => {
  const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return p.piVersion === pi && p.piWebUiVersion === web;
});
if (!profileFile) {
  console.error(`未找到匹配 profile：pi ${pi} + pi-web-ui ${web}`);
  console.error('为防止误改 node_modules，未应用任何补丁。');
  process.exit(2);
}
const profile = JSON.parse(fs.readFileSync(path.join(dir, profileFile), 'utf8'));
for (const rel of profile.patches) {
  const file = path.join(root, rel);
  const cmd = file.endsWith('.ps1') ? 'powershell.exe' : process.execPath;
  const args = file.endsWith('.ps1') ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] : [file];
  cp.execFileSync(cmd, args, { stdio: 'inherit' });
}
console.log(`✓ 已应用 profile：${profileFile}`);
