const http = require('http');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8788;
const WEB_PORT = 8787;
const cwd = path.resolve(__dirname, '..');
const settingsFile = path.join(os.homedir(), '.pi', 'agent', 'settings.json');

/** 与 launcher 保持一致：便携安装优先使用 install.json 记录的真实 shim。 */
function resolveShim() {
  let shim = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'pi-web-ui.cmd');
  try {
    const install = JSON.parse(fs.readFileSync(path.join(cwd, 'install.json'), 'utf8'));
    if (install.shim && fs.existsSync(install.shim)) shim = install.shim;
  } catch {}
  return shim;
}
const shim = resolveShim();
let restarting = false;

/** Windows 系统代理（WinINET）：pi settings.json 里的 httpProxy 丢了之后的兜底。 */
function systemProxy() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command',
       "$k=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; if($k -and $k.ProxyEnable -eq 1){[string]$k.ProxyServer}"],
      { encoding: 'utf8', timeout: 8000 },
    ).trim();
    if (!out) return '';
    let srv = out;
    // ProxyServer 可能是 "host:port" 或 "http=host:port;https=host:port"
    if (srv.includes('=')) {
      const map = {};
      for (const kv of srv.split(';')) {
        const i = kv.indexOf('=');
        if (i > 0) map[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
      }
      srv = map.https || map.http || '';
    }
    if (!srv) return '';
    return /^https?:\/\//i.test(srv) ? srv : 'http://' + srv;
  } catch {
    return '';
  }
}
function envForWeb() {
  const env = { ...process.env };
  try {
    const install = JSON.parse(fs.readFileSync(path.join(cwd, 'install.json'), 'utf8'));
    if (install.nodeDir && fs.existsSync(install.nodeDir)) env.PATH = `${install.nodeDir};${env.PATH || ''}`;
  } catch {}
  try {
    let proxy = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).httpProxy;
    if (!proxy) proxy = systemProxy();
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
  if (!fs.existsSync(shim)) throw new Error(`找不到 pi-web-ui 启动命令：${shim}`);
  const quote = value => `"${String(value).replace(/"/g, '\\"')}"`;
  const command = `${quote(shim)} --no-browser --cwd ${quote(cwd)}`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { detached: true, stdio: 'ignore', env: envForWeb() });
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
