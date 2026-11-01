import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
const raw = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
function fixture() {
  const timers = new Set(), routes = new Map(); let responseCallback, request;
  const context = {
    http: { request(_options, callback) { responseCallback = callback; request = new EventEmitter(); request.end = () => {}; request.destroy = () => { request.destroyed = true; }; return request; } },
    process: { env: { PI_WEB_UI_WATCHDOG_PORT: '12345' } }, Buffer,
    setTimeout(fn, ms) { const t = { fn, ms }; timers.add(t); return t; },
    clearTimeout(t) { timers.delete(t); },
  };
  vm.runInNewContext(raw.replace(/^import .*;\r?\n/gm, '').replace('export default {', 'globalThis.plugin = {'), context);
  context.plugin.activate({ route(method, name, handler) { routes.set(`${method} ${name}`, handler); } });
  const invoke = () => {
    let body, status = 200;
    const promise = routes.get('POST /restart')({}, { status(code) { status = code; return this; }, json(value) { body = value; } });
    return { promise, result: () => ({ body, status }) };
  };
  const respond = (text, { end = true } = {}) => {
    const res = new EventEmitter(); res.statusCode = 202; res.setEncoding = () => {}; res.destroy = () => {};
    responseCallback(res); if (text) res.emit('data', text); if (end) res.emit('end'); return res;
  };
  return { timers, invoke, respond, request: () => request };
}
test('持续慢速分块响应也有墙钟总时限，不依赖socket闲置超时', async () => {
  const f = fixture(); const call = f.invoke(); const res = f.respond('{', {end:false});
  res.emit('data', '"ok":');
  assert.equal(f.timers.size, 1, '必须注册独立于socket活动的总时限');
  const deadline = [...f.timers][0]; assert.equal(deadline.ms, 5000); deadline.fn();
  await call.promise; assert.equal(call.result().status, 503); assert.equal(call.result().body.ok, false); assert.equal(f.request().destroyed, true); assert.equal(f.timers.size, 0);
});
test('成功响应清理时限计时器，迟到网络事件不能改写结果', async () => {
  const f = fixture(); const call = f.invoke(); f.respond('{"ok":true,"operation":{"id":"test"}}'); await call.promise;
  assert.equal(call.result().status, 202); assert.equal(f.timers.size, 0);
  f.request().emit('error', Error('迟到错误')); assert.equal(call.result().body.ok, true);
});
