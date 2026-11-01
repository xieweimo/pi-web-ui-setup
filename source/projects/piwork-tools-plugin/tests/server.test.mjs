import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

// 原样执行服务端逻辑，只替换 Node 边界。严禁测试启动真实 PowerShell/git/同步。
const raw = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
function fixture({ config, settings, env = {}, valid = [], spawnError, notifyError, streaming = false } = {}) {
  const calls = [], notices = [], timers = new Set(), routes = new Map();
  let runEvent, unsubscribed = false;
  const makeChild = () => {
    const value = new EventEmitter(); value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
    value.stdout.setEncoding = value.stderr.setEncoding = () => {};
    value.kill = () => { calls.push('kill'); }; return value;
  };
  let child;
  const context = {
    existsSync: file => valid.some(root => file === path.join(root, 'scripts', 'sync-pi-web-ui-setup.ps1')),
    readFileSync: () => JSON.stringify(config ?? {}), dirname: path.dirname, join: path.join,
    fileURLToPath: () => path.resolve('work/tests/fake-plugin/index.mjs'),
    execFileSync: (...args) => { calls.push(['git', ...args]); return ' M scripts/example.ps1\n?? docs/example.md\n'; },
    spawn: (...args) => { calls.push(['spawn', ...args]); if (spawnError) throw Error('spawn failed'); child = makeChild(); return child; },
    process: { env }, Buffer, Date,
    setTimeout: fn => { const timer = { fn, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  };
  const source = raw.replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', '"file:///fake/index.mjs"').replace('export default {', 'globalThis.plugin = {');
  vm.runInNewContext(source, context, { filename: 'piwork-tools/index.mjs' });
  const host = {
    route: (method, route, fn) => routes.set(`${method} ${route}`, fn),
    getSettings: () => settings,
    onRunEvent: fn => { runEvent = fn; return () => { unsubscribed = true; }; },
    getActiveConversation: () => { if (streaming instanceof Error) throw streaming; return { isStreaming: streaming }; },
    notify: (...args) => { if (notifyError) throw Error('notify failed'); notices.push(args); }, log() {},
  };
  const invoke = (method, route) => {
    let status = 200, body;
    const response = { status(code) { status = code; return this; }, json(value) { body = JSON.parse(JSON.stringify(value)); return this; } };
    routes.get(`${method} ${route}`)({}, response);
    return { status, body };
  };
  return { plugin: context.plugin, host, invoke, calls, notices, timers, get child() { return child; }, event: value => runEvent(value), unsubscribed: () => unsubscribed };
}

test('未配置路径时返回明确错误且不执行任何外部命令', async () => {
  const f = fixture(); const stop = await f.plugin.activate(f.host);
  try { const r = f.invoke('POST', '/sync'); assert.equal(r.status, 400); assert.match(r.body.error, /还没配置/); assert.equal(f.calls.length, 0); }
  finally { stop(); }
});
test('无效候选会回退；状态查询不触发同步', async () => {
  const f = fixture({ config: { repoRoot: 'invalid' }, settings: { repoRoot: 'valid' }, env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] });
  const stop = await f.plugin.activate(f.host);
  try { const r = f.invoke('GET', '/state'); assert.equal(r.body.root, 'valid'); assert.deepEqual(r.body.candidates, ['invalid', 'valid']); assert.equal(f.calls.length, 0); }
  finally { stop(); }
});
test('配置文件优先且重复点击返回409，仅启动一次进程', async () => {
  const f = fixture({ config: { repoRoot: "work/it's repo" }, settings: { repoRoot: 'other' }, valid: ["work/it's repo", 'other'] });
  const stop = await f.plugin.activate(f.host);
  try {
    const first = f.invoke('POST', '/sync'); assert.equal(first.status, 200); assert.equal(first.body.root, "work/it's repo");
    assert.equal(f.invoke('POST', '/sync').status, 409);
    const calls = f.calls.filter(x => Array.isArray(x) && x[0] === 'spawn'); assert.equal(calls.length, 1);
    assert.match(calls[0][2].at(-1), /it''s repo/); assert.equal(calls[0][3].windowsHide, true);
    f.child.emit('close', 0); assert.equal(f.invoke('GET', '/state').body.exitCode, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.notices[0][0], 'info');
  } finally { stop(); }
});
test('同步非零退出不会误报成功，stderr与退出码进入状态', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); f.child.stderr.emit('data', '校验失败\r\n'); f.child.emit('close', 2);
    const s = f.invoke('GET', '/state').body; assert.equal(s.running, false); assert.equal(s.exitCode, 2); assert.deepEqual(s.lines, ['校验失败']); assert.equal(f.notices[0][0], 'error');
  } finally { stop(); }
});
test('输出有界：只保留80行快照，每行最多500字符', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); f.child.stdout.emit('data', Array.from({length: 500}, (_, i) => `${i}:` + '中'.repeat(600)).join('\n'));
    f.child.emit('close', 0);
    const s = f.invoke('GET', '/state').body; assert.equal(s.lines.length, 80); assert.ok(s.lines[0].startsWith('420:')); assert.ok(s.lines.every(x => x.length <= 500));
    f.child.emit('close', 0);
  } finally { stop(); }
});
test('spawn同步异常返回400，不残留running状态和超时器', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'], spawnError: true }); const stop = await f.plugin.activate(f.host);
  try { assert.equal(f.invoke('POST', '/sync').status, 400); assert.equal(f.invoke('GET', '/state').body.running, false); assert.equal(f.timers.size, 0); }
  finally { stop(); }
});
test('通知异常不破坏已完成的作业状态', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'], notifyError: true }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); assert.doesNotThrow(() => f.child.emit('close', 0)); assert.equal(f.invoke('GET', '/state').body.exitCode, 0); }
  finally { stop(); }
});
test('忙碌事件配对、计数不为负，宿主查询异常时回退事件计数', async () => {
  const f = fixture({ streaming: Error('宿主不可用') }); const stop = await f.plugin.activate(f.host);
  try { f.event({type:'run_end'}); assert.equal(f.invoke('GET', '/busy').body.activeRuns, 0);
    f.event({type:'run_start'}); assert.equal(f.invoke('GET', '/busy').body.busy, true);
    f.event({type:'run_end'}); assert.equal(f.invoke('GET', '/busy').body.busy, false);
  } finally { stop(); } assert.equal(f.unsubscribed(), true);
});
test('子进程异步启动错误保留诊断，close后解除并发锁', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); f.child.emit('error', Error('ENOENT powershell'));
    f.child.emit('close', -4058); const s = f.invoke('GET', '/state').body;
    assert.equal(s.running, false); assert.equal(s.exitCode, -4058); assert.match(s.error, /ENOENT/); assert.equal(f.timers.size, 0);
  } finally { stop(); }
});
test('宿主流式状态可单独阻止启动器误停服', async () => {
  const f = fixture({ streaming: true }); const stop = await f.plugin.activate(f.host);
  try { const s = f.invoke('GET', '/busy').body; assert.equal(s.busy, true); assert.equal(s.streaming, true); assert.equal(s.activeRuns, 0); }
  finally { stop(); }
});
test('前次失败后允许重试且清空旧错误输出', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); f.child.stderr.emit('data', '旧错误'); f.child.emit('close', 2);
    assert.equal(f.invoke('POST', '/sync').status, 200); const s = f.invoke('GET', '/state').body;
    assert.equal(s.running, true); assert.equal(s.exitCode, null); assert.equal(s.error, null); assert.deepEqual(s.lines, []);
    f.child.emit('close', 0);
  } finally { stop(); }
});
test('同步运行时busy必须为真，防止关页面后启动器误停服', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); assert.equal(f.invoke('GET', '/busy').body.busy, true);
    f.child.emit('close', 0); assert.equal(f.invoke('GET', '/busy').body.busy, false);
  } finally { stop(); }
});
test('卸载中的同步关闭busy并保留失败状态', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  f.invoke('POST', '/sync'); stop(); const state = f.invoke('GET', '/state').body;
  assert.equal(state.running, false); assert.equal(state.exitCode, null); assert.match(state.error, /卸载|取消/);
  assert.equal(f.timers.size, 0);
});
test('重载后旧进程的迟到close/error不得污染新同步', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] });
  const firstStop = await f.plugin.activate(f.host); f.invoke('POST', '/sync'); const oldChild = f.child; firstStop();
  const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); oldChild.stdout.emit('data', '旧输出'); oldChild.stderr.emit('data', '旧诊断'); oldChild.emit('error', Error('旧进程错误')); oldChild.emit('close', 2);
    const s = f.invoke('GET', '/state').body; assert.equal(s.running, true); assert.equal(s.error, null); assert.equal(s.exitCode, null); assert.equal(f.timers.size, 1); assert.deepEqual(s.lines, []);
    f.child.emit('close', 0); assert.equal(f.notices.length, 1);
  } finally { stop(); }
});
test('超时后迟到的exit0不得误报同步成功', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); [...f.timers][0].fn(); f.child.emit('close', 0);
    const s = f.invoke('GET', '/state').body; assert.equal(s.running, false); assert.equal(s.exitCode, 124); assert.match(s.error, /超时/); assert.equal(f.notices[0][0], 'error');
  } finally { stop(); }
});
test('终止请求失败时保留忙碌锁并显示未确认停止，不允许再启动同步', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); f.child.kill = () => false; [...f.timers][0].fn();
    const s = f.invoke('GET', '/state').body; assert.equal(s.running, true); assert.match(s.error, /超时.*未确认/); assert.equal(f.invoke('POST', '/sync').status, 409);
  } finally { stop(); }
});
test('stdout与stderr跨块分行独立拼接且close时保存末行', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  try { f.invoke('POST', '/sync'); f.child.stdout.emit('data', '安装'); f.child.stderr.emit('data', '校验'); f.child.stdout.emit('data', '完成\r\n'); f.child.stderr.emit('data', '失败\n'); f.child.stdout.emit('data', '末行'); f.child.emit('close', 2);
    assert.deepEqual(f.invoke('GET', '/state').body.lines, ['安装完成', '校验失败', '末行']);
  } finally { stop(); }
});
test('超时及卸载会清理子进程与计时器，不遗留后台同步', async () => {
  const f = fixture({ env: { PIWORK_ROOT: 'valid' }, valid: ['valid'] }); const stop = await f.plugin.activate(f.host);
  f.invoke('POST', '/sync'); [...f.timers][0].fn(); assert.ok(f.calls.includes('kill')); f.child.emit('close', null);
  assert.equal(f.invoke('GET', '/state').body.exitCode, 124); stop(); assert.equal(f.timers.size, 0); assert.equal(f.unsubscribed(), true);
});
