import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchdog, pollOperation } from '../client/entry.mjs';

test('watchdog 不可达时给出守护进程与端口信息，而非 Failed to fetch', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(watchdog(8790, '/state'), /重启守护未运行或无法连接（127\.0\.0\.1:8790）/);
  } finally { globalThis.fetch = original; }
});

test('watchdog HTTP 错误不被当作已就绪', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: '守护不可用' }) });
  try {
    await assert.rejects(watchdog(8790, '/state'), /守护不可用/);
  } finally { globalThis.fetch = original; }
});

test('轮询正常结束并转发最新状态', async () => {
  const states = [];
  let count = 0;
  const result = await pollOperation({
    port: 8790, delay: async () => {},
    fetchState: async () => (++count === 1 ? { phase: 'starting', operation: { action: 'restart' } } : { phase: 'healthy', operation: null }),
    onState: (state) => states.push(state.phase),
  });
  assert.equal(result.phase, 'healthy');
  assert.deepEqual(states, ['starting', 'healthy']);
});

test('轮询连续三次断线必须退出，而非永久卡在 busy', async () => {
  let attempts = 0;
  await assert.rejects(pollOperation({
    port: 8790, delay: async () => {}, onState: () => {},
    fetchState: async () => { attempts++; throw new TypeError('Failed to fetch'); },
  }), /重启守护已断开，操作结果未知/);
  assert.equal(attempts, 3);
});

test('轮询持续收到 operation 时到期必须退出', async () => {
  let time = 0;
  await assert.rejects(pollOperation({
    port: 8790, timeoutMs: 1500, intervalMs: 500, now: () => time,
    delay: async (ms) => { time += ms; }, onState: () => {},
    fetchState: async () => ({ phase: 'starting', operation: { action: 'restart' } }),
  }), /操作结果未知/);
  assert.equal(time, 1500);
});
