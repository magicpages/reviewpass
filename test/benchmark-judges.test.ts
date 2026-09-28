/**
 * A judge call must survive a provider failure that arrives as a 200 with the
 * error in the body - measured on a real judge run - rather than spend its
 * attempts retrying at once while the provider is still down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, isObject, Spend, type Judge } from '../benchmark/judges.js';

test('an in-body provider error is waited out, then retried, and the next good reply returned', { timeout: 20_000 }, async () => {
  let calls = 0;
  const at: number[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      at.push(Date.now());
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(calls === 1
        ? { choices: [{ finish_reason: 'error', error: { code: 502, message: 'provider_unavailable' }, message: { content: '' } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 } }
        : { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const judge: Judge = { name: 'stub', endpoint: `http://127.0.0.1:${port}/v1`, model: 'm', key: 'k', price: { input: 1, output: 1 } };
  try {
    const v = await ask(judge, 'sys', 'user', { type: 'object' },
      (x: unknown): x is { ok: boolean } => isObject(x) && x.ok === true, new Spend(1));
    assert.deepEqual(v, { ok: true });
    assert.equal(calls, 2);
    assert.ok(at[1]! - at[0]! >= 4_500, `retried after ${at[1]! - at[0]!}ms: a provider that is down needs time, not an instant retry`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

async function stub(replies: object[], fn: (judge: Judge, calls: () => number, budgets: number[]) => Promise<void>) {
  let calls = 0;
  const budgets: number[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      budgets.push((JSON.parse(raw) as { max_tokens: number }).max_tokens);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(replies[Math.min(calls++, replies.length - 1)]));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    await fn({ name: 'stub', endpoint: `http://127.0.0.1:${port}/v1`, model: 'm', key: 'k', price: { input: 1, output: 1 } }, () => calls, budgets);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const good = { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
const isOk = (x: unknown): x is { ok: boolean } => isObject(x) && x.ok === true;

test('an upstream rate limit reported in a 200 body is waited out too', { timeout: 20_000 }, async () => {
  const limited = { error: { code: 429, message: 'temporarily rate-limited upstream' } };
  await stub([limited, good], async (judge, calls) => {
    const t = Date.now();
    assert.deepEqual(await ask(judge, 'sys', 'user', { type: 'object' }, isOk, new Spend(1)), { ok: true });
    assert.equal(calls(), 2);
    assert.ok(Date.now() - t >= 4_500, 'retried at once');
  });
});

test('an identical judge call is served from the cache; a changed one is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-cache-'));
  process.env.BENCH_JUDGE_CACHE = dir;
  try {
    await stub([good], async (judge, calls) => {
      await ask(judge, 'sys', 'user', { type: 'object' }, isOk, new Spend(1));
      await ask(judge, 'sys', 'user', { type: 'object' }, isOk, new Spend(1));
      assert.equal(calls(), 1, 'the repeat was paid for again');
      await ask(judge, 'sys', 'another user prompt', { type: 'object' }, isOk, new Spend(1));
      assert.equal(calls(), 2, 'a different prompt must not reuse the answer');
    });
  } finally {
    delete process.env.BENCH_JUDGE_CACHE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spend counts what the endpoint billed when it reports it, the price table otherwise', () => {
  const judge: Judge = { name: 'j', endpoint: '', model: 'm', key: '', price: { input: 1, output: 1 } };
  const s = new Spend(10);
  s.add(judge, 1_000_000, 0, 2.5);
  assert.equal(s.spent, 2.5, 'the billed figure, not 1.00 from the table');
  s.add(judge, 1_000_000, 0);
  assert.equal(s.spent, 3.5);
  assert.throws(() => s.add(judge, 0, 0, 7), /passed the cap of 10/);
});

test('an endpoint failure spends neither an answer attempt nor a budget step', { timeout: 30_000 }, async () => {
  const limited = { error: { code: 429, message: 'rate-limited upstream' } };
  const bad = { choices: [{ finish_reason: 'stop', message: { content: '{"ok":false}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  await stub([limited, bad, bad, bad, good], async (judge, calls, budgets) => {
    assert.deepEqual(await ask(judge, 'sys', 'user', { type: 'object' }, isOk, new Spend(1)), { ok: true },
      'three bad answers after a rate limit still leave the fourth attempt');
    assert.equal(calls(), 5);
    assert.deepEqual(budgets, [16_384, 16_384, 32_768, 49_152, 65_536], 'the retry after a rate limit must not raise the budget');
  });
});

test('a call that gets no reply before its deadline is waited out and retried', { timeout: 30_000 }, async () => {
  let calls = 0;
  const hung: import('node:http').ServerResponse[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (calls++ === 0) { hung.push(res); return; } // never answers
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(good));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const judge: Judge = { name: 'stub', endpoint: `http://127.0.0.1:${port}/v1`, model: 'm', key: 'k', timeoutMs: 200,
    price: { input: 1, output: 1 } };
  try {
    assert.deepEqual(await ask(judge, 'sys', 'user', { type: 'object' }, isOk, new Spend(1)), { ok: true });
    assert.equal(calls, 2);
  } finally {
    for (const r of hung) r.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
