import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';

test('后端只有成功获取有效 watchdog 状态才报告已就绪', async () => {
  let status = 503;
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 200 ? JSON.stringify({ phase: 'healthy', services: [] }) : JSON.stringify({ error: '暂不可用' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const prior = process.env.PI_WEB_UI_WATCHDOG_PORT;
  try {
    process.env.PI_WEB_UI_WATCHDOG_PORT = String(server.address().port);
    const plugin = (await import('../index.mjs')).default;
    let handler;
    plugin.activate({ route(method, path, fn) { if (method === 'GET' && path === '/state') handler = fn; } });
    const read = async () => {
      let result;
      await handler({}, { json(value) { result = value; } });
      return result;
    };
    const unavailable = await read();
    assert.equal(unavailable.watchdog, false);
    assert.equal(unavailable.backendOnline, true);
    status = 200;
    const ready = await read();
    assert.equal(ready.watchdog, true);
    assert.equal(ready.phase, 'healthy');
  } finally {
    if (prior === undefined) delete process.env.PI_WEB_UI_WATCHDOG_PORT;
    else process.env.PI_WEB_UI_WATCHDOG_PORT = prior;
    server.close();
    await once(server, 'close');
  }
});
