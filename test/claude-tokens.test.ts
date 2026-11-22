/**
 * Several subscription tokens: used in order, each set aside while it is at its
 * limit, with the marks shared through a state file and no token ever written.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTokenPool, COOLDOWN, parseTokens, resetAt, tokenId } from '../src/model/claude-tokens.js';
import { claudeEnv, ClaudeLimitError } from '../src/model/claude-code.js';
import { ModelClient } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';

afterEach(() => { for (const k of ['REVIEWPASS_BACKEND', 'REVIEWPASS_CLAUDE_COMMAND', 'REVIEWPASS_CLAUDE_TOKENS', 'REVIEWPASS_CLAUDE_TOKEN_STATE']) delete process.env[k]; });

const state = () => join(mkdtempSync(join(tmpdir(), 'claude-tokens-')), 'nested', 'state.json');

test('tokens are read from lines or commas, once each', () => {
  assert.deepEqual(parseTokens('a\nb, c ,a\n\n'), ['a', 'b', 'c']);
  assert.deepEqual(parseTokens(undefined), []);
});

test('the first token not set aside is used, and a mark outlives the pool that made it', () => {
  let now = 1_000;
  const path = state();
  const pool = new ClaudeTokenPool(['tok-a', 'tok-b'], path, () => now);
  assert.equal(pool.pick()!.token, 'tok-a');
  pool.setAside(tokenId('tok-a'), 'limit');
  const other = new ClaudeTokenPool(['tok-a', 'tok-b'], path, () => now);
  assert.equal(other.pick()!.token, 'tok-b', 'another review on the machine skips the spent token');
  assert.equal(other.nextFree(), 1_000 + COOLDOWN.limit);
  now += COOLDOWN.limit;
  assert.equal(other.pick()!.token, 'tok-a', 'it comes back when its time is up');
  assert.doesNotMatch(readFileSync(path, 'utf8'), /tok-/, 'no token is written, only its hash');
});

test('a state file that cannot be written still sets the token aside in this process', () => {
  const blocker = join(mkdtempSync(join(tmpdir(), 'claude-tokens-')), 'a-file');
  writeFileSync(blocker, '');
  const pool = new ClaudeTokenPool(['tok-a', 'tok-b'], join(blocker, 'state.json'));
  pool.setAside(tokenId('tok-a'), 'limit');
  assert.equal(pool.pick()!.token, 'tok-b');
});

test('a token at its limit comes back when the reset the CLI names has passed', () => {
  // 2026-11-22 14:46:28 UTC = 15:46 in Vienna (CET); "4pm" there is 15:00 UTC.
  let now = Date.UTC(2026, 10, 22, 14, 46, 28);
  const pool = new ClaudeTokenPool(['tok-a', 'tok-b'], state(), () => now);
  pool.setAside(tokenId('tok-a'), 'limit', "Claude subscription limit: You've hit your session limit · resets 4pm (Europe/Vienna)");
  assert.equal(pool.pick()!.token, 'tok-b');
  now = Date.UTC(2026, 10, 22, 15, 1, 1);
  assert.equal(pool.pick()!.token, 'tok-a', 'back a minute after 15:00 UTC, not an hour after the refusal');
});

test('reset phrases: later today, tomorrow, a named day, a summer offset, and ones that cannot be placed', () => {
  const now = Date.UTC(2026, 10, 22, 14, 46); // Sunday, 15:46 in Vienna
  assert.equal(resetAt("You've hit your weekly limit · resets 6pm (Europe/Vienna)", now), Date.UTC(2026, 10, 22, 17, 0));
  assert.equal(resetAt('resets 11:30am (Europe/Vienna)', now), Date.UTC(2026, 10, 23, 10, 30), 'a time already past today is tomorrow');
  assert.equal(resetAt('resets 12am (Europe/Vienna)', now), Date.UTC(2026, 10, 22, 23, 0), 'midnight');
  assert.equal(resetAt('resets Fri 12am (Europe/Vienna)', now), Date.UTC(2026, 10, 26, 23, 0));
  assert.equal(resetAt('resets Nov 25, 6pm (Europe/Vienna)', now), Date.UTC(2026, 10, 25, 17, 0));
  assert.equal(resetAt('resets 4pm (Europe/Vienna)', Date.UTC(2026, 6, 1, 10, 0)), Date.UTC(2026, 6, 1, 14, 0), 'CEST is UTC+2');
  // 23:30 CET on Mar 28; 24 hours later is already 00:30 CEST on Mar 30.
  assert.equal(resetAt('resets 4pm (Europe/Vienna)', Date.UTC(2026, 2, 28, 22, 30)), Date.UTC(2026, 2, 29, 14, 0), 'the night the clocks go forward');
  assert.equal(resetAt('resets 4pm (Mars/Olympus)', now), undefined);
  assert.equal(resetAt('resets 4pm', now), undefined);
  assert.equal(resetAt("You've hit your weekly limit · resets Oct 27", now), undefined);
});

test('a refusal naming no reset parks the token for the fallback hour', () => {
  let now = 0;
  const pool = new ClaudeTokenPool(['tok-a', 'tok-b'], state(), () => now);
  pool.setAside(tokenId('tok-a'), 'limit', 'usage limit reached');
  now += COOLDOWN.limit;
  assert.equal(pool.pick()!.token, 'tok-a');
});

test('the CLI gets the one token for its call, never the list under either name', () => {
  const env = claudeEnv({ REVIEWPASS_CLAUDE_TOKENS: 'a,b', WARREN_CLAUDE_TOKENS: 'a,b', CLAUDE_CODE_OAUTH_TOKEN: 'old', PATH: '/bin' }, 'b');
  assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: 'b', PATH: '/bin' });
});

test('a token at its limit is set aside and the call moves to the next; with all spent, the limit stands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const record = join(dir, 'calls.log');
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  require('fs').appendFileSync(${JSON.stringify(record)}, t + '\\n');
  const spent = (process.env.SPENT || '').split(',');
  if (spent.includes(t)) {
    process.stdout.write(JSON.stringify({ subtype: 'success', is_error: true, result: "You've hit your session limit · resets 11pm" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { ok: t } }));
});
`);
  chmodSync(fake, 0o755);
  process.env.REVIEWPASS_BACKEND = 'claude-code';
  process.env.REVIEWPASS_CLAUDE_COMMAND = fake;
  process.env.REVIEWPASS_CLAUDE_TOKENS = 'tok-a\ntok-b';
  process.env.REVIEWPASS_CLAUDE_TOKEN_STATE = state();
  process.env.SPENT = 'tok-a';
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
  const client = new ModelClient(cfg);
  const ask = () => client.json<{ ok: string }>([{ role: 'user', content: 'x' }], { type: 'object' });

  assert.deepEqual((await ask()).value, { ok: 'tok-b' });
  assert.deepEqual((await ask()).value, { ok: 'tok-b' });
  assert.deepEqual(readFileSync(record, 'utf8').trim().split('\n'), ['tok-a', 'tok-b', 'tok-b'],
    'the second call goes straight to the next token');

  process.env.SPENT = 'tok-a,tok-b';
  await assert.rejects(ask(), (e: unknown) => e instanceof ClaudeLimitError && /all 2 tokens are at their limit/.test((e as Error).message));
  delete process.env.SPENT;
});
