const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SERVICE_PORT = 18987;
const SECOND_SERVICE_PORT = 18988;
const WATCHDOG_PORT = 18990;
const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'work', 'watchdog-test');
const descriptorFile = path.join(testDir, 'descriptor.json');
const restartStamp = path.join(testDir, 'restart.stamp');
const stateFile = path.join(require('os').tmpdir(), `pi-web-ui-recovery-watchdog-${WATCHDOG_PORT}.json`);

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function waitFor(fn, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try { return await fn(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('等待超时');
}
function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {}
}

if (process.argv.includes('--fixture')) {
  const fixtureIndex = process.argv.indexOf('--fixture');
  const fixturePort = Number(process.argv[fixtureIndex + 1] || SERVICE_PORT);
  const fixtureLabel = process.argv[fixtureIndex + 2] || 'main';
  const childCode = `require('http').createServer((q,s)=>{s.end(${JSON.stringify(fixtureLabel)}+':'+process.pid)}).listen(${fixturePort},'127.0.0.1')`;
  const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore', windowsHide: true });
  const shutdown = () => { try { child.kill(); } catch {} process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  setInterval(() => {}, 1000);
} else {
  (async () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(descriptorFile, JSON.stringify({
      command: 'node',
      args: [__filename, '--fixture', String(SERVICE_PORT), 'main'],
      cwd: root,
      servicePort: SERVICE_PORT,
      healthUrl: `http://127.0.0.1:${SERVICE_PORT}/`,
      label: 'watchdog 自动测试',
      profile: 'development',
      actions: ['reload', 'restart', 'start', 'stop'],
      watchdogPort: WATCHDOG_PORT,
      startupTimeoutMs: 10000,
      shell: true,
      stop: { mode: 'process-tree', portFallback: true, allowUnowned: false },
    }, null, 2));
    fs.rmSync(stateFile, { force: true });
    const watchdog = spawn(process.execPath, [path.join(__dirname, 'pi-web-ui-recovery-watchdog.js'), '--descriptor', descriptorFile], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_WEB_UI_RESTART_STAMP: restartStamp },
    });
    let trackedPid;
    try {
      await waitFor(() => request(WATCHDOG_PORT, '/state'));
      await request(WATCHDOG_PORT, '/start', 'POST');
      const firstServicePid = Number((await waitFor(() => request(SERVICE_PORT, '/'))).body.split(':')[1]);
      const firstState = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
      trackedPid = firstState.pid;
      assert(Number.isInteger(firstServicePid) && firstServicePid > 0);
      assert(Number.isInteger(trackedPid) && trackedPid > 0);
      await waitFor(async () => {
        const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
        if (state.operation || state.phase !== 'healthy') throw new Error('首次启动尚未完成');
        return state;
      });

      assert.strictEqual((await request(WATCHDOG_PORT, '/restart', 'POST')).status, 202);
      const secondServicePid = Number((await waitFor(async () => {
        const response = await request(SERVICE_PORT, '/');
        if (Number(response.body.split(':')[1]) === firstServicePid) throw new Error('仍是旧服务进程');
        return response;
      }, 12000)).body.split(':')[1]);
      const secondState = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
      trackedPid = secondState.pid;
      assert.notStrictEqual(secondServicePid, firstServicePid);
      assert.notStrictEqual(secondState.pid, firstState.pid);
      await waitFor(async () => {
        const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
        if (state.operation || state.phase !== 'healthy') throw new Error('重启尚未完成');
        return state;
      });

      assert.strictEqual((await request(WATCHDOG_PORT, '/stop', 'POST')).status, 202);
      await waitFor(async () => {
        try { await request(SERVICE_PORT, '/'); } catch { return true; }
        throw new Error('服务仍在监听');
      });
      trackedPid = null;
      await waitFor(async () => {
        const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
        if (state.operation || state.phase !== 'stopped') throw new Error('停止操作尚未完成');
        return state;
      });

      // 多服务 descriptor：前端和后端分别拥有根进程，可单独重启，也可整体启停。
      fs.writeFileSync(descriptorFile, JSON.stringify({
        label: 'watchdog 多服务自动测试',
        profile: 'development',
        watchdogPort: WATCHDOG_PORT,
        primaryServiceId: 'backend',
        services: {
          backend: {
            label: 'Node 后端', kind: 'backend', command: 'node',
            args: [__filename, '--fixture', String(SERVICE_PORT), 'backend'], cwd: root,
            servicePort: SERVICE_PORT, healthUrl: `http://127.0.0.1:${SERVICE_PORT}/`, shell: true,
            actions: ['restart', 'start', 'stop'], stop: { mode: 'process-tree', portFallback: true, allowUnowned: false }, order: 10,
          },
          frontend: {
            label: 'Vite 前端', kind: 'frontend', command: 'node',
            args: [__filename, '--fixture', String(SECOND_SERVICE_PORT), 'frontend'], cwd: root,
            servicePort: SECOND_SERVICE_PORT, healthUrl: `http://127.0.0.1:${SECOND_SERVICE_PORT}/`, shell: true,
            actions: ['restart', 'start', 'stop'], stop: { mode: 'process-tree', portFallback: true, allowUnowned: false }, order: 20,
          },
        },
      }, null, 2));
      assert.strictEqual((await request(WATCHDOG_PORT, '/start', 'POST')).status, 202);
      const firstBackendPid = Number((await waitFor(async () => {
        const response = await request(SERVICE_PORT, '/');
        if (!response.body.startsWith('backend:')) throw new Error('后端尚未启动');
        return response;
      })).body.split(':')[1]);
      const firstFrontendPid = Number((await waitFor(async () => {
        const response = await request(SECOND_SERVICE_PORT, '/');
        if (!response.body.startsWith('frontend:')) throw new Error('前端尚未启动');
        return response;
      })).body.split(':')[1]);
      await waitFor(async () => {
        const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
        if (state.operation || !state.services.every((service) => service.healthy)) throw new Error('多服务启动尚未完成');
        return state;
      });

      assert.strictEqual((await request(WATCHDOG_PORT, '/services/frontend/restart', 'POST')).status, 202);
      const secondFrontendPid = Number((await waitFor(async () => {
        const response = await request(SECOND_SERVICE_PORT, '/');
        const pid = Number(response.body.split(':')[1]);
        if (pid === firstFrontendPid) throw new Error('Vite 测试服务仍是旧进程');
        return response;
      }, 12000)).body.split(':')[1]);
      assert.notStrictEqual(secondFrontendPid, firstFrontendPid);
      assert.strictEqual(Number((await request(SERVICE_PORT, '/')).body.split(':')[1]), firstBackendPid, '单独重启前端不应重启后端');
      await waitFor(async () => {
        const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
        if (state.operation) throw new Error('单服务重启尚未完成');
        return state;
      });

      assert.strictEqual((await request(WATCHDOG_PORT, '/stop', 'POST')).status, 202);
      await waitFor(async () => {
        const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
        if (state.operation || state.services.some((service) => service.healthy)) throw new Error('多服务停止尚未完成');
        return state;
      });

      // 安全边界：端口上存在不是 watchdog 启动的服务时，默认拒绝接管， 
      // 避免与 pi-web-ui server install/systemd/launchd 双重管理。
      const foreign = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>s.end('foreign')).listen(${SERVICE_PORT},'127.0.0.1');setInterval(()=>{},1000)`], { stdio: 'ignore', windowsHide: true });
      try {
        await waitFor(async () => {
          const response = await request(SERVICE_PORT, '/');
          if (response.body !== 'foreign') throw new Error('外部测试服务尚未接管端口');
          return response;
        });
        const foreignState = await waitFor(async () => {
          const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
          if (!state.services.find((service) => service.id === 'backend')?.healthy) throw new Error('watchdog 尚未识别外部测试服务');
          return state;
        });
        const refused = await request(WATCHDOG_PORT, '/services/backend/restart', 'POST');
        assert.strictEqual(refused.status, 409, `外部服务保护失效：state=${JSON.stringify(foreignState)} response=${refused.body}`);
        const refusal = JSON.parse(refused.body);
        assert.strictEqual(refusal.code, 'unowned');
        assert.strictEqual(refusal.canForce, true);
        assert.match(refusal.error, /不是由本 watchdog 启动|管理/);
        assert.strictEqual((await request(SERVICE_PORT, '/')).body, 'foreign', '被拒绝时不得动到外部进程');
        await waitFor(async () => {
          const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
          if (state.operation) throw new Error('拒绝后不应有操作在跑');
          return state;
        });

        // 界面二次确认后带 force=1：必须能接管外部进程，否则“都能重启”就是空话。
        assert.strictEqual((await request(WATCHDOG_PORT, '/services/backend/restart?force=1', 'POST')).status, 202);
        const takenOver = await waitFor(async () => {
          const response = await request(SERVICE_PORT, '/');
          if (response.body === 'foreign') throw new Error('外部进程仍占用端口');
          if (!response.body.startsWith('backend:')) throw new Error('接管后服务尚未就绪');
          return response;
        }, 15000);
        assert.match(takenOver.body, /^backend:/);
        const takeoverState = await waitFor(async () => {
          const state = JSON.parse((await request(WATCHDOG_PORT, '/state')).body);
          if (state.operation) throw new Error('接管操作尚未完成');
          const backend = state.services.find((service) => service.id === 'backend');
          if (!backend || !backend.ownsProcess) throw new Error('接管后未被本 watchdog 管理');
          return state;
        });
        assert.strictEqual(takeoverState.services.find((s) => s.id === 'backend').unowned, false);
      } finally {
        killTree(foreign.pid);
      }
      console.log('watchdog 测试通过：单服务兼容、多服务独立重启/整体启停、状态反馈、拒绝接管未授权进程、force 接管外部进程均正常');
    } finally {
      if (trackedPid) killTree(trackedPid);
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        for (const service of Object.values(state.services || {})) if (service.pid) killTree(Number(service.pid));
      } catch {}
      killTree(watchdog.pid);
      fs.rmSync(testDir, { recursive: true, force: true });
      fs.rmSync(stateFile, { force: true });
    }
  })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
