/**
 * The configured model timeout has to be the one that applies.
 *
 * Node's `fetch` caps response headers at undici's 300s default and nothing the
 * caller passes can raise it, so `requestTimeoutMs` was decorative: a model
 * slower than five minutes to produce headers failed as `TypeError: fetch
 * failed` whatever the config said, and raising the setting changed nothing.
 *
 * The stub server below never answers and is not a model — that is the point.
 * What is under test is the transport's limit, not a reply. A request that
 * respected undici's default would sit here for five minutes and never finish.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetch as undiciFetch } from 'undici';
import { modelTransport } from '../src/model/client.js';

test('the configured timeout bounds the request, not undici\'s 5-minute default', { timeout: 20_000 }, async () => {
  const server = createServer(() => { /* accept the request and never reply */ });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };

  const agent = modelTransport(600);
  const started = Date.now();
  const err = await undiciFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', body: '{}', dispatcher: agent,
  }).then(() => null, (e: unknown) => e);
  const took = Date.now() - started;

  assert.ok(err, 'the stub never replies, so the request must not have resolved');
  assert.match(String(err), /fetch failed/);
  // The specific failure the configured timeout is meant to replace: headers
  // that never arrive. Not a connection error, which would prove nothing.
  assert.equal((err as { cause?: { code?: string } }).cause?.code, 'UND_ERR_HEADERS_TIMEOUT');
  assert.ok(took < 5_000, `gave up after ${took}ms, so the configured 600ms is not what applied`);

  agent.close();
  await new Promise<void>((r) => server.close(() => r()));
});
