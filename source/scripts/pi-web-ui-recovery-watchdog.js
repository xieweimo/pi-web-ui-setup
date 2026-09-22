const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_WATCHDOG_PORT = 8790;
const DEFAULT_SERVICE_PORT = 8787;
const workspace = path.resolve(__dirname, '..');
const settingsFile = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
const restartStamp = process.env.PI_WEB_UI_RESTART_STAMP || path.join(os.tmpdir(), 'pi-web-ui-restart.stamp');
const stateFile = (watchdogPort) => path.join(os.tmpdir(), `pi-web-ui-recovery-watchdog-${watchdogPort}.json`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function resolveLegacyDescriptor() {
  let shim = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'pi-web-ui.cmd');
  let node = process.execPath;
  try {
    const install = readJson(path.join(workspace, 'install.json'));
    if (install.shim && fs.existsSync(install.shim)) shim = install.shim;
    if (install.nodeDir && fs.existsSync(path.join(install.nodeDir, 'node.exe'))) node = path.join(install.nodeDir, 'node.exe');
  } catch {}
  const entry = path.join(path.dirname(shim), 'node_modules', 'pi-web-ui', 'bin', 'pi-web-ui.mjs');
  return {
    label: 'pi-web-ui 用户环境',
    profile: 'user',
    watchdogPort: DEFAULT_WATCHDOG_PORT,
    command: node,
    args: [entry, '--no-browser', '--cwd', workspace],
    cwd: workspace,
    servicePort: DEFAULT_SERVICE_PORT,
    healthUrl: `http://127.0.0.1:${DEFAULT_SERVICE_PORT}/`,
    actions: ['restart', 'start', 'stop'],
    env: {},
    stop: { mode: 'process-tree', portFallback: true, allowUnowned: false },
  };
}
function normalizeService(id, raw, defaults) {
  if (!raw || typeof raw.command !== 'string' || !raw.command.trim()) throw new Error(`服务 ${id} 缺少 command`);
  if (raw.args !== undefined && !Array.isArray(raw.args)) throw new Error(`服务 ${id} 的 args 必须是数组`);
  const servicePort = Number(raw.servicePort || defaults.servicePort || DEFAULT_SERVICE_PORT);
  const service = {
    id,
    label: String(raw.label || id),
    kind: String(raw.kind || 'service'),
    description: String(raw.description || ''),
    command: raw.command,
    args: (raw.args || []).map(String),
    cwd: path.resolve(raw.cwd || defaults.cwd || process.cwd()),
    servicePort,
    healthUrl: raw.healthUrl || `http://127.0.0.1:${servicePort}/`,
    env: { ...(defaults.env || {}), ...(raw.env && typeof raw.env === 'object' ? raw.env : {}) },
    shell: Boolean(raw.shell),
    stdoutFile: raw.stdoutFile ? path.resolve(raw.stdoutFile) : null,
    stderrFile: raw.stderrFile ? path.resolve(raw.stderrFile) : null,
    startupTimeoutMs: Number(raw.startupTimeoutMs || defaults.startupTimeoutMs || 60000),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
    actions: (Array.isArray(raw.actions) ? raw.actions.map(String) : ['restart', 'start', 'stop']).filter((action) => action !== 'reload'),
    stop: { mode: 'process-tree', portFallback: false, allowUnowned: false, ...(defaults.stop || {}), ...(raw.stop || {}) },
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`服务 id 无效：${id}`);
  if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) throw new Error(`服务 ${id} 的 servicePort 无效：${servicePort}`);
  if (!Number.isFinite(service.startupTimeoutMs) || service.startupTimeoutMs < 1000 || service.startupTimeoutMs > 300000) throw new Error(`服务 ${id} 的 startupTimeoutMs 无效`);
  if (!fs.existsSync(service.cwd)) throw new Error(`服务 ${id} 的启动目录不存在：${service.cwd}`);
  if (service.stop.mode !== 'process-tree') throw new Error(`服务 ${id} 不支持 stop.mode=${service.stop.mode}`);
  const allowedActions = new Set(['restart', 'start', 'stop']);
  if (service.actions.some((action) => !allowedActions.has(action))) throw new Error(`服务 ${id} 的 actions 只允许 restart/start/stop`);
  service.actions = [...new Set(service.actions)];
  for (const [key, value] of Object.entries(service.env)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`服务 ${id} 的环境变量 ${key} 必须是字符串、数字或布尔值`);
    service.env[key] = String(value);
  }
  return service;
}
function loadDescriptor() {
  const file = argument('--descriptor') || process.env.PI_WEB_UI_RESTART_DESCRIPTOR;
  const raw = file ? readJson(path.resolve(file)) : resolveLegacyDescriptor();
  const watchdogPort = Number(raw.watchdogPort || DEFAULT_WATCHDOG_PORT);
  if (!Number.isInteger(watchdogPort) || watchdogPort < 1 || watchdogPort > 65535) throw new Error(`watchdogPort 无效：${watchdogPort}`);
  const defaults = {
    cwd: raw.cwd,
    env: raw.env,
    stop: raw.stop,
    startupTimeoutMs: raw.startupTimeoutMs,
    servicePort: raw.servicePort,
  };
  // 旧式单服务 descriptor 没有 services 段：自动补一个更贴切的显示名，
  // 免得界面上出现“重启 pi-web-ui 用户环境”这种把环境名当服务名的按钮。
  const entries = raw.services && typeof raw.services === 'object' && !Array.isArray(raw.services)
    ? Object.entries(raw.services)
    : [['main', { ...raw, label: raw.serviceLabel || '网页服务', description: raw.serviceDescription || 'API、WebSocket、会话与网页界面' }]];
  if (!entries.length) throw new Error('restart descriptor 至少需要一个服务');
  const services = Object.fromEntries(entries.map(([id, value]) => [id, normalizeService(id, value, defaults)]));
  const primaryServiceId = services[raw.primaryServiceId] ? raw.primaryServiceId : Object.keys(services)[0];
  return {
    label: String(raw.label || 'pi-web-ui'),
    profile: raw.profile === 'development' ? 'development' : 'user',
    // 可选：声明“这个实例本来是交给谁管的”，例如 'pi-web-ui server install'。
    // 仅用于界面提示，不影响能否操作。
    managedBy: raw.managedBy ? String(raw.managedBy) : null,
    watchdogPort,
    primaryServiceId,
    services,
  };
}

function systemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "$k=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; if($k -and $k.ProxyEnable -eq 1){[string]$k.ProxyServer}"], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
    if (!out) return '';
    let server = out;
    if (server.includes('=')) {
      const map = {};
      for (const item of server.split(';')) {
        const index = item.indexOf('=');
        if (index > 0) map[item.slice(0, index).trim().toLowerCase()] = item.slice(index + 1).trim();
      }
      server = map.https || map.http || '';
    }
    return !server ? '' : (/^https?:\/\//i.test(server) ? server : `http://${server}`);
  } catch { return ''; }
}
function proxyAvailable(proxy) {
  try {
    const url = new URL(proxy);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || process.platform !== 'win32') return true;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) -ne $null`], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
    return out.toLowerCase() === 'true';
  } catch { return false; }
}
// "判断代理端口是否在监听" 要跑一次 PowerShell（100～300ms）。启动服务时才会用到，
// 但连续重启会把同样的探测重复很多遍，缓存 30 秒。
let proxyProbeCache = { proxy: '', available: false, at: 0 };
function cachedProxyAvailable(proxy) {
  if (proxyProbeCache.proxy !== proxy || Date.now() - proxyProbeCache.at > 30000) {
    proxyProbeCache = { proxy, available: proxyAvailable(proxy), at: Date.now() };
  }
  return proxyProbeCache.available;
}
function environment(descriptor, service) {
  const env = { ...process.env, ...service.env };
  try {
    let proxy = readJson(settingsFile).httpProxy;
    if (proxy && !cachedProxyAvailable(proxy)) proxy = '';
    if (!proxy) proxy = systemProxy();
    if (proxy) { env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; }
  } catch {}
  const noProxy = new Set(String(env.NO_PROXY || '').replace(/["']/g, '').split(',').map((x) => x.trim()).filter(Boolean));
  ['localhost', '127.0.0.1', '::1'].forEach((value) => noProxy.add(value));
  env.NO_PROXY = [...noProxy].join(',');
  env.no_proxy = env.NO_PROXY;
  env.PI_WEB_UI_WATCHDOG_PORT = String(descriptor.watchdogPort);
  return env;
}

function readState(descriptor) {
  let state = {};
  try { state = readJson(stateFile(descriptor.watchdogPort)); } catch {}
  if (!state.services) {
    const first = descriptor.primaryServiceId;
    state = { services: state.pid ? { [first]: { ...state } } : {}, updatedAt: state.updatedAt || null };
  }
  return state;
}
function writeState(descriptor, state) {
  try { fs.writeFileSync(stateFile(descriptor.watchdogPort), JSON.stringify(state)); } catch {}
}
function updateServiceState(descriptor, id, patch) {
  const root = readState(descriptor);
  root.services = { ...(root.services || {}) };
  root.services[id] = { ...(root.services[id] || {}), ...patch, updatedAt: new Date().toISOString() };
  root.updatedAt = new Date().toISOString();
  writeState(descriptor, root);
  return root.services[id];
}
function serviceState(descriptor, id) {
  return readState(descriptor).services?.[id] || {};
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function stopTree(pid) {
  if (!processAlive(pid)) return;
  try {
    if (process.platform === 'win32') {
      // windowsHide 必须显式给：否则每次重启/停止服务都会闪一个控制台黑框。
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    } else {
      process.kill(-pid, 'SIGTERM');
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && processAlive(pid)) Atomics.wait(waitArray, 0, 0, 50);
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}
/** 进程的父进程 PID 与命令行（探测外部 supervisor 用）。 */
function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if($p){[string]$p.ParentProcessId+'|'+[string]$p.CommandLine}`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      if (!out) return null;
      const index = out.indexOf('|');
      return { ppid: Number(out.slice(0, index)), command: out.slice(index + 1) };
    }
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (!out) return null;
    const match = /^(\d+)\s+([\s\S]*)$/.exec(out);
    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch { return null; }
}

/**
 * 这个端口的进程是不是被别的 supervisor 管着？
 *
 * 只在自己不拥有该进程时才调用，避免每次状态查询都跑外部命令。识别方式与上游
 * server/launch-origin.ts 保持一致：Windows 看 %APPDATA%\pi-web-ui\<name>.pid 里
 * 记录的 PowerShell 守护 PID 是否就是目标进程的父进程；Linux 看 cgroup 里的 unit。
 * 返回 null 表示没看出托管关系（前台 / npm start / 手动 node）。
 */
function detectExternalSupervisor(pid) {
  const info = processInfo(pid);
  if (!info) return null;
  if (process.platform === 'win32') {
    const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pi-web-ui');
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.pid')) continue;
        const recorded = Number(String(fs.readFileSync(path.join(dir, file), 'utf8')).trim());
        if (!recorded || recorded !== info.ppid) continue;
        const parent = processInfo(recorded);
        if (parent && /Start-Sleep|while/i.test(parent.command)) {
          return { kind: 'windows-watchdog', name: file.replace(/\.pid$/i, ''), detail: 'pi-web-ui server install 的 PowerShell 守护循环' };
        }
      }
    } catch {}
    if (/powershell/i.test(info.command) && /Start-Sleep/i.test(info.command)) {
      return { kind: 'windows-watchdog', name: '', detail: 'PowerShell 守护循环' };
    }
    return null;
  }
  if (info.ppid !== 1) return null;
  if (process.platform === 'linux') {
    try {
      const match = /([A-Za-z0-9_.@-]+)\.service/.exec(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
      if (match) return { kind: 'systemd', name: match[1], detail: 'systemd 服务（Restart=always）' };
    } catch {}
    return { kind: 'orphan', name: '', detail: '父进程已退出（可能是前台残留或 nohup）' };
  }
  if (process.platform === 'darwin') return { kind: 'launchd', name: '', detail: 'launchd 托管（KeepAlive）' };
  return null;
}

/** 外部 supervisor 的中文说明，用于界面警告。 */
function supervisorWarning(supervisor) {
  if (!supervisor) return '';
  if (supervisor.kind === 'windows-watchdog') return `该实例由 ${supervisor.detail}${supervisor.name ? `（${supervisor.name}）` : ''}管理：重启会与它抢控制权，可能双启动或占用端口失败。`;
  if (supervisor.kind === 'systemd') return `该实例由 systemd 服务 ${supervisor.name} 管理（Restart=always）：停止后会被自动拉起，与手动重启冲突。`;
  if (supervisor.kind === 'launchd') return '该实例由 launchd 管理（KeepAlive）：停止后会被自动拉起，与手动重启冲突。';
  return `该实例${supervisor.detail}，不由本 watchdog 启动。`;
}

function listeningPids(port) {
  try {
    if (process.platform === 'win32') {
      const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
      return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim().split(/\s+/).map(Number).filter(Number.isInteger);
    }
    return execFileSync('sh', ['-c', `command -v lsof >/dev/null 2>&1 && lsof -nP -t -iTCP:${port} -sTCP:LISTEN || true`], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim().split(/\s+/).map(Number).filter(Number.isInteger);
  } catch { return []; }
}
function stopService(descriptor, service, options = {}) {
  const state = serviceState(descriptor, service.id);
  const ownedPid = Number(state.pid);
  const ownsProcess = processAlive(ownedPid);
  if (ownsProcess) stopTree(ownedPid);
  // force = 经界面二次确认的“接管”：允许按端口结束不属于自己的进程，
  // 用于接管 pi-web-ui server install / systemd 管理的实例。
  if (options.force || (service.stop.portFallback && (ownsProcess || service.stop.allowUnowned))) {
    for (const pid of listeningPids(service.servicePort)) stopTree(pid);
  }
  updateServiceState(descriptor, service.id, { pid: null, phase: 'stopped', stoppedAt: new Date().toISOString() });
  return { ownsProcess, stoppedPid: ownsProcess ? ownedPid : null };
}
function startService(descriptor, service) {
  if (!service.shell && path.isAbsolute(service.command) && !fs.existsSync(service.command)) throw new Error(`服务 ${service.label} 的启动命令不存在：${service.command}`);
  const opened = [];
  const output = (file) => {
    if (!file) return 'ignore';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    opened.push(fd);
    return fd;
  };
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    // Windows 上不能 detached：那会让子进程建立自己的控制台，而 Windows 11 默认把新控制台
    // 交给 Windows Terminal，于是服务会带着一个可见窗口出现（标题就是 node.exe 路径）；
    // 用户关掉那个窗口 = 给进程发 CTRL_CLOSE_EVENT，服务直接挂掉（退出码 0xC000013A）。
    // 去掉 detached 后子进程继承 watchdog 的隐藏控制台，配合 windowsHide 完全不可见，
    // 父进程退出也不会带走子进程。类 Unix 仍用 detached 建立独立进程组（stopTree 靠它）。
    detached: process.platform !== 'win32',
    stdio: ['ignore', output(service.stdoutFile), output(service.stderrFile)],
    shell: service.shell,
    env: environment(descriptor, service),
    windowsHide: true,
  });
  for (const fd of opened) fs.closeSync(fd);
  updateServiceState(descriptor, service.id, {
    pid: child.pid || null,
    phase: 'starting',
    startedAt: new Date().toISOString(),
    command: service.command,
    cwd: service.cwd,
    lastError: null,
    lastExit: null,
  });
  child.once('error', (error) => {
    console.error(`[watchdog:${service.id}] 启动失败：${error.message}`);
    const current = serviceState(descriptor, service.id);
    if (!child.pid || Number(current.pid) === child.pid) updateServiceState(descriptor, service.id, { pid: null, phase: 'failed', lastError: error.message });
  });
  child.once('exit', (code, signal) => {
    const current = serviceState(descriptor, service.id);
    if (Number(current.pid) !== child.pid) return;
    const expected = ['stopping', 'restarting', 'stopped'].includes(current.phase);
    updateServiceState(descriptor, service.id, {
      pid: null,
      phase: expected ? 'stopped' : 'failed',
      lastExit: { code, signal, at: new Date().toISOString() },
      lastError: expected || code === 0 ? null : `启动命令已退出（code=${code}, signal=${signal || 'none'}）`,
    });
  });
  child.unref();
  return child.pid;
}
function markRestart() {
  try { fs.writeFileSync(restartStamp, String(Date.now())); } catch {}
}
function reply(res, code, body) {
  const origin = String(res.req?.headers?.origin || '');
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' };
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(code, headers);
  res.end(JSON.stringify(body));
}
function healthCheck(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    try {
      const client = new URL(url).protocol === 'https:' ? https : http;
      const req = client.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForHealth(descriptor, service, expected) {
  const deadline = Date.now() + service.startupTimeoutMs;
  while (Date.now() < deadline) {
    const healthy = await healthCheck(service.healthUrl);
    if (healthy === expected) return true;
    if (expected) {
      const state = serviceState(descriptor, service.id);
      if (state.phase === 'failed' && !processAlive(Number(state.pid))) throw new Error(state.lastError || `${service.label} 在就绪前退出`);
    }
    await sleep(250);
  }
  throw new Error(`${service.label}${expected ? '启动' : '停止'}超时：${service.healthUrl}`);
}
async function publicState(descriptor, operation) {
  const stored = readState(descriptor);
  const services = [];
  for (const service of Object.values(descriptor.services).sort((a, b) => a.order - b.order)) {
    let state = stored.services?.[service.id] || {};
    const healthy = await healthCheck(service.healthUrl);
    const pid = processAlive(Number(state.pid)) ? Number(state.pid) : null;
    if (healthy && state.phase === 'starting') state = updateServiceState(descriptor, service.id, { phase: 'healthy', lastError: null });
    // 端口上有东西但不归自己管 —— 可能是 server install / systemd / 手动启动的实例。
    // 只有这种情况才去跑外部命令探测（状态查询的常态开销保持为零）。
    let occupied = healthy;
    let foreignPid = null;
    if (!pid) {
      const listeners = listeningPids(service.servicePort);
      foreignPid = listeners[0] ?? null;
      occupied = occupied || listeners.length > 0;
    }
    const unowned = !pid && occupied;
    const externalSupervisor = foreignPid ? detectExternalSupervisor(foreignPid) : null;
    // 不能直接信任记录的 phase：`node --watch` 主进程不会因为它的脚本崩溃而退出，
    // 所以 exit 回调根本不会触发，state 会一直停在 healthy。这里以“进程是否真在”为准。
    let phase;
    if (pid) phase = healthy ? (state.phase === 'starting' ? 'starting' : 'healthy') : (state.lastExit ? 'failed' : state.phase || 'starting');
    else if (unowned) phase = state.lastExit ? 'failed' : 'unowned';
    else phase = state.phase === 'failed' ? 'failed' : 'stopped';
    const lastExit = pid ? null : state.lastExit || null;
    services.push({
      occupied,
      unowned,
      foreignPid,
      externalSupervisor,
      warning: unowned ? supervisorWarning(externalSupervisor) || `端口 ${service.servicePort} 上的进程不是本 watchdog 启动的：接管会和它的原管理器抢控制权。` : '',
      id: service.id,
      label: service.label,
      kind: service.kind,
      description: service.description,
      actions: service.actions,
      servicePort: service.servicePort,
      healthUrl: service.healthUrl,
      healthy,
      pid,
      ownsProcess: Boolean(pid),
      phase,
      lastError: state.lastError || null,
      lastExit,
      startedAt: state.startedAt || null,
      updatedAt: state.updatedAt || null,
    });
  }
  const primary = services.find((item) => item.id === descriptor.primaryServiceId) || services[0];
  const warnings = services.filter((item) => item.warning).map((item) => `${item.label}：${item.warning}`);
  return {
    ok: true,
    label: descriptor.label,
    profile: descriptor.profile,
    managedBy: descriptor.managedBy,
    watchdogPort: descriptor.watchdogPort,
    primaryServiceId: descriptor.primaryServiceId,
    operation,
    warnings,
    services,
    serviceHealthy: services.every((item) => item.healthy),
    servicePort: primary?.servicePort,
    healthUrl: primary?.healthUrl,
    pid: primary?.pid || null,
    phase: operation ? `${operation.action}:${operation.targets.join(',')}` : services.every((item) => item.healthy) ? 'healthy' : services.some((item) => item.healthy) ? 'partial' : 'stopped',
    lastError: services.find((item) => item.lastError)?.lastError || null,
  };
}

function main() {
  let descriptor = loadDescriptor();
  let operation = null;
  const reloadDescriptor = () => {
    const updated = loadDescriptor();
    if (updated.watchdogPort !== descriptor.watchdogPort) throw new Error('运行中的 watchdog 不能切换端口，请先停止旧进程');
    descriptor = updated;
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return reply(res, 204, {});
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/state')) {
      try { reloadDescriptor(); } catch {}
      return reply(res, 200, await publicState(descriptor, operation));
    }
    let action = null;
    let targetIds = [];
    let allTargets = false;
    const serviceMatch = /^\/services\/([A-Za-z0-9._-]+)\/(restart|start|stop)$/.exec(requestUrl.pathname);
    if (req.method === 'POST' && serviceMatch) {
      action = serviceMatch[2];
      targetIds = [serviceMatch[1]];
    } else if (req.method === 'POST' && /^\/(restart|start|stop)$/.test(requestUrl.pathname)) {
      action = requestUrl.pathname.slice(1);
      allTargets = true;
    }
    if (!action) return reply(res, 404, { ok: false, error: 'not found' });
    try { reloadDescriptor(); } catch (error) { return reply(res, 400, { ok: false, error: error.message }); }
    if (allTargets) targetIds = Object.keys(descriptor.services);
    const targets = targetIds.map((id) => descriptor.services[id]).filter(Boolean);
    if (targets.length !== targetIds.length) return reply(res, 404, { ok: false, error: `未知服务：${targetIds.join(',')}` });
    for (const service of targets) {
      if (!service.actions.includes(action)) return reply(res, 403, { ok: false, error: `${service.label} 未开放 ${action} 操作` });
    }
    if (operation) return reply(res, 409, { ok: false, operation, error: `正在执行 ${operation.action}，请等待完成` });

    // force=1：界面二次确认后的“接管”。允许操作不属于自己的端口进程，
    // 但会明确返回它将与原管理器冲突 —— 默认（不带 force）仍然拒绝。
    const force = requestUrl.searchParams.get('force') === '1';
    for (const service of targets) {
      const state = serviceState(descriptor, service.id);
      const ownsProcess = processAlive(Number(state.pid));
      const healthy = await healthCheck(service.healthUrl);
      const listeners = listeningPids(service.servicePort);
      const occupied = healthy || listeners.length > 0;
      if (action === 'start' && ownsProcess && !healthy) return reply(res, 409, { ok: false, error: `${service.label} 进程仍在运行但尚未就绪；请等待或执行重启` });
      if (action !== 'start' && occupied && !ownsProcess && !service.stop.allowUnowned && !force) {
        const supervisor = listeners[0] ? detectExternalSupervisor(listeners[0]) : null;
        return reply(res, 409, {
          ok: false,
          code: 'unowned',
          service: service.id,
          supervisor,
          canForce: true,
          error: supervisorWarning(supervisor) || `拒绝操作 ${service.label}：端口 ${service.servicePort} 上的进程不是由本 watchdog 启动。`,
        });
      }
    }

    operation = { id: `${Date.now()}-${action}`, action, targets: targetIds, force, startedAt: new Date().toISOString() };
    for (const service of targets) updateServiceState(descriptor, service.id, { phase: action === 'restart' ? 'restarting' : action === 'stop' ? 'stopping' : 'starting', lastError: null });
    reply(res, 202, { ok: true, operation });
    setTimeout(async () => {
      try {
        markRestart();
        if (action !== 'start') {
          for (const service of [...targets].sort((a, b) => b.order - a.order)) stopService(descriptor, service, { force });
          await Promise.all(targets.map((service) => waitForHealth(descriptor, service, false)));
        }
        if (action !== 'stop') {
          for (const service of [...targets].sort((a, b) => a.order - b.order)) {
            const healthy = await healthCheck(service.healthUrl);
            if (action === 'start' && healthy) continue;
            startService(descriptor, service);
            await waitForHealth(descriptor, service, true);
            updateServiceState(descriptor, service.id, { phase: 'healthy', lastError: null });
          }
        }
      } catch (error) {
        const message = error?.message || String(error);
        console.error(`[watchdog] ${error?.stack || message}`);
        for (const service of targets) {
          const state = serviceState(descriptor, service.id);
          if (state.phase !== 'healthy' && state.phase !== 'stopped') updateServiceState(descriptor, service.id, { phase: 'failed', lastError: message });
        }
      } finally {
        operation = null;
      }
    }, 80);
  });
  server.listen(descriptor.watchdogPort, '127.0.0.1', () => {
    console.log(`[watchdog] 127.0.0.1:${descriptor.watchdogPort} -> ${Object.keys(descriptor.services).join(', ')}`);
  });
}

if (require.main === module) main();
module.exports = { loadDescriptor, stopTree, listeningPids, startService, stopService, healthCheck };
