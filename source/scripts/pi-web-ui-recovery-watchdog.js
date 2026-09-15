const http = require('http');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8788;
const WEB_PORT = 8787;
const cwd = path.resolve(__dirname, '..');
const shim = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'pi-web-ui.cmd');
const settingsFile = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
let restarting = false;

function envForWeb() {
  const env = { ...process.env };
  try {
    const proxy = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).httpProxy;
    if (proxy) {
      env.HTTP_PROXY ||= proxy;
      env.HTTPS_PROXY ||= proxy;
      const noProxy = new Set(String(env.NO_PROXY || '').split(',').filter(Boolean));
      ['localhost', '127.0.0.1', '::1'].forEach(x => noProxy.add(x));
      env.NO_PROXY = [...noProxy].join(',');
      env.no_proxy = env.NO_PROXY;
    }
  } catch {}
  return env;
}
// 重启前写时间戳：launcher 的停服计时读到更新的 stamp 就重新计时，
// 否则「关闭→重启」期间页面短暂无连接，刚拉起的服务会被 launcher 立刻杀掉。
const RESTART_STAMP = path.join(os.tmpdir(), 'pi-web-ui-restart.stamp');
function markRestart() {
  try { fs.writeFileSync(RESTART_STAMP, String(Date.now())); } catch {}
}
function stopWeb() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore' });
  } catch {}
}
function startWeb() {
  if (!fs.existsSync(shim)) throw new Error('pi-web-ui.cmd not found');
  const child = spawn('cmd.exe', ['/c', shim, '--no-browser', '--cwd', cwd], { detached: true, stdio: 'ignore', env: envForWeb() });
  child.unref();
}
function reply(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:8787', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  res.end(JSON.stringify(body));
}
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return reply(res, 204, {});
  if (req.method !== 'POST' || req.url !== '/restart') return reply(res, 404, { ok: false });
  if (restarting) return reply(res, 202, { ok: true, restarting: true });
  restarting = true;
  reply(res, 202, { ok: true, restarting: true });
  setTimeout(() => { markRestart(); try { stopWeb(); startWeb(); } finally { setTimeout(() => { restarting = false; }, 5000); } }, 80);
});
server.listen(PORT, '127.0.0.1');
