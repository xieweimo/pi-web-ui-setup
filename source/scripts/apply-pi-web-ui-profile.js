#!/usr/bin/env node
/** 根据已安装的 pi / pi-web-ui 版本，选择并安全应用对应补丁 profile。 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const root = path.resolve(__dirname, '..');
const npmRoot = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const pkg = (name) => JSON.parse(fs.readFileSync(path.join(npmRoot, 'npm', 'node_modules', name, 'package.json'), 'utf8')).version;
const pi = pkg('@earendil-works/pi-coding-agent');
const web = pkg('pi-web-ui');
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
