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

/** The error code undici attaches to a failed `fetch`, if it carries one. */
function causeCode(err: unknown): unknown {
  if (!(err instanceof Error)) return undefined;
  const cause: unknown = err.cause;
  return cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
}

/** How long a request bound by `configuredMs` takes to give up, and how. */
async function gaveUpAfter(configuredMs: number, url: string) {
  const agent = modelTransport(configuredMs);
  const started = Date.now();
  try {
    const err = await undiciFetch(url, { method: 'POST', body: '{}', dispatcher: agent })
      .then(() => null, (e: unknown) => e);
    return { took: Date.now() - started, err };
  } finally {
    await agent.close();
  }
}

test('the configured timeout bounds the request, not undici\'s 5-minute default', { timeout: 20_000 }, async () => {
  const server = createServer(() => { /* accept the request and never reply */ });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;

    // Two settings, because one proves less than it looks. A single request is
    // bounded by *some* timeout, and five seconds is satisfied by a hard-coded
    // one that ignores the config entirely. Two requests whose windows do not
    // overlap can only both hold if the configured value is the one applied.
    const quick = await gaveUpAfter(300, url);
    const slow = await gaveUpAfter(1_200, url);

    for (const [configured, { took, err }] of [[300, quick], [1_200, slow]] as const) {
      assert.ok(err, `the stub never replies, so the ${configured}ms request must not resolve`);
      assert.match(String(err), /fetch failed/);
      // Headers that never arrive: the failure the configured timeout is meant
      // to produce, not a connection error, which would prove nothing.
      assert.equal(causeCode(err), 'UND_ERR_HEADERS_TIMEOUT');
      // Not before it was told to give up, and not long after. The windows
      // ([300,1100) and [1200,2000)) are disjoint by construction.
      assert.ok(
        took >= configured && took < configured + 800,
        `configured ${configured}ms but gave up after ${took}ms`,
      );
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
