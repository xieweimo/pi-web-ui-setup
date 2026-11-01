import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';

// 仅连接测试创建的随机端口假 watchdog，绝不访问真实 8790 或停服。
async function fixture(reply) {
  const calls = [];
  const server = http.createServer((req, res) => { calls.push(`${req.method} ${req.url}`); reply(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const previous = process.env.PI_WEB_UI_WATCHDOG_PORT;
  process.env.PI_WEB_UI_WATCHDOG_PORT = String(port);
  let plugin;
  try { plugin = (await import(`../index.mjs?testPort=${port}`)).default; }
  finally { if (previous === undefined) delete process.env.PI_WEB_UI_WATCHDOG_PORT; else process.env.PI_WEB_UI_WATCHDOG_PORT = previous; }
  const routes = new Map();
  const stop = plugin.activate({ route(method, route, handler) { routes.set(`${method} ${route}`, handler); } });
  return { calls, routes, async invoke(route) {
    let status = 200, body;
    await routes.get(route)({}, { status(code) { status = code; return this; }, json(value) { body = value; return this; } });
    return { status, body };
  }, async close() { stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('start/restart/stop仅转发到各自端点，保留202与operation', async () => {
  const f = await fixture((_req, res) => { res.writeHead(202, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true, operation:{id:'test-only'}})); });
  try { for (const action of ['start', 'restart', 'stop']) { const r = await f.invoke(`POST /${action}`); assert.equal(r.status, 202); assert.equal(r.body.operation.id, 'test-only'); }
    assert.deepEqual(f.calls, ['POST /start', 'POST /restart', 'POST /stop']);
  } finally { await f.close(); }
});
test('守护409冲突不被包装成成功，错误原文保留', async () => {
  const f = await fixture((_req, res) => { res.writeHead(409); res.end(JSON.stringify({ok:false,error:'已有作业运行'})); });
  try { const r = await f.invoke('POST /restart'); assert.equal(r.status, 409); assert.equal(r.body.ok, false); assert.equal(r.body.error, '已有作业运行'); }
  finally { await f.close(); }
});
test('HTTP 200但显式ok:false仍判操作失败', async () => {
  const f = await fixture((_req, res) => { res.end(JSON.stringify({ok:false,error:'权限不足'})); });
  try { const r = await f.invoke('POST /start'); assert.equal(r.body.ok, false); assert.equal(r.body.error, '权限不足'); }
  finally { await f.close(); }
});
test('HTTP 200缺少phase时状态不得假报watchdog就绪', async () => {
  const f = await fixture((_req, res) => { res.end(JSON.stringify({ok:true})); });
  try { const r = await f.invoke('GET /state'); assert.equal(r.body.backendOnline, true); assert.equal(r.body.watchdog, false); }
  finally { await f.close(); }
});
test('非JSON错误响应保留诊断且不报告就绪', async () => {
  const f = await fixture((_req, res) => { res.writeHead(502); res.end('bad gateway'); });
  try { const r = await f.invoke('GET /state'); assert.equal(r.body.watchdog, false); assert.equal(r.body.watchdogStatus, 502); assert.equal(r.body.watchdogError, 'bad gateway'); }
  finally { await f.close(); }
});
test('HTTP 200的HTML或非对象JSON不得伪装成操作成功', async () => {
  for (const body of ['<html>proxy login</html>', '[]', '"unexpected"', '42', 'null', '']) {
    const f = await fixture((_req, res) => { res.end(body); });
    try { const r = await f.invoke('POST /restart'); assert.equal(r.status, 502, `非法正文：${body}`); assert.equal(r.body.ok, false); }
    finally { await f.close(); }
  }
});
test('超大响应拒绝处理且返回有界诊断', async () => {
  const f = await fixture((_req, res) => { res.end(JSON.stringify({ok:true,padding:'x'.repeat(300000)})); });
  try { const r = await f.invoke('POST /start'); assert.equal(r.status, 502); assert.equal(r.body.ok, false); assert.ok(r.body.error.length < 1000); }
  finally { await f.close(); }
});
test('响应中途断开必须结束请求而非悬挂', async () => {
  const f = await fixture((_req, res) => { res.writeHead(200, {'content-length':'100'}); res.flushHeaders(); res.write('{'); setImmediate(() => res.destroy()); });
  let timer;
  try { const r = await Promise.race([f.invoke('POST /stop'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('请求未及时结束')), 1000); })]);
    assert.equal(r.body.ok, false); assert.ok([502,503].includes(r.status));
  } finally { clearTimeout(timer); await f.close(); }
});
test('连接被拒绝时操作返回503，后端状态接口仍能响应', async () => {
  const f = await fixture((_req, res) => res.end('{}'));
  // 先关闭测试监听端口，仍只访问这个随机测试端口。
  await f.close();
  const r = await f.invoke('POST /stop'); assert.equal(r.status, 503); assert.equal(r.body.ok, false);
  const state = await f.invoke('GET /state'); assert.equal(state.body.backendOnline, true); assert.equal(state.body.watchdog, false);
});
