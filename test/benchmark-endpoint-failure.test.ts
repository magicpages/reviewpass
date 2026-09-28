/**
 * A file the endpoint lost says nothing about the method, so its run is redone;
 * a file the model fumbled is the method's result, so its run stands. Getting
 * this backwards either flatters a model by retrying it until it works, or
 * blames it for a rate limit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointFailure } from '../benchmark/runs.js';

test('rate limits, outages and timeouts are the endpoint\'s', () => {
  for (const m of [
    'review failed for a.ts: Error: model unreachable after retries (rate limited 7x): Error: model 429: {"error":"too many requests"}',
    'review failed for a.ts: Error: model unreachable after retries: Error: upstream 503: unavailable',
    'review failed for a.ts: Error: upstream 502: bad gateway',
    'review failed for a.ts: Error: model 429: slow down',
    'review failed for a.ts: Error: model 402: {"error":"insufficient credits"}',
    'review failed for a.ts: Error: model 401: invalid key',
    'review failed for a.ts: TypeError: fetch failed',
    'review failed for a.ts: Error: request timed out',
  ]) assert.equal(endpointFailure(m), true, m);
});

test('a malformed or empty reply is the model\'s', () => {
  for (const m of [
    'review failed for a.ts: Error: model reply had no findings array (recovered an object of the wrong shape)',
    "review failed for a.ts: Error: model reply's 3 finding(s) had no line numbers, title or body (a reply that ignored the schema)",
    'review failed for a.ts: Error: model ran out of budget: finish_reason=length, budget=512',
  ]) assert.equal(endpointFailure(m), false, m);
});
