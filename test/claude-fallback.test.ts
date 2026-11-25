/**
 * With every Claude token at its limit, calls go to the configured fallback
 * endpoint instead of refusing the review - and only then.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelClient } from '../src/model/client.js';
import { ClaudeLimitError } from '../src/model/claude-code.js';
import { loadConfig } from '../src/config/index.js';
import { renderReviewSummary } from '../src/review/render.js';
import type { ReviewResult } from '../src/types.js';

const ENV = [
  'REVIEWPASS_BACKEND', 'REVIEWPASS_CLAUDE_COMMAND', 'REVIEWPASS_CLAUDE_TOKENS', 'REVIEWPASS_CLAUDE_TOKEN_STATE',
  'REVIEWPASS_FALLBACK_ENDPOINT', 'REVIEWPASS_FALLBACK_MODEL', 'REVIEWPASS_FALLBACK_API_KEY',
  'REVIEWPASS_FALLBACK_REASONING_EFFORT', 'REVIEWPASS_FALLBACK_PROVIDER', 'SPENT',
];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** A fake CLI: tokens listed in SPENT answer with a session limit, the rest with `{ ok: <token> }`. */
function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if ((process.env.SPENT || '').split(',').includes(t)) {
    process.stdout.write(JSON.stringify({ subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets 6pm" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { ok: t } }));
});
`);
  chmodSync(fake, 0o755);
  return fake;
}

interface Seen { body: Record<string, unknown>; auth?: string }

async function withStub(fn: (base: string, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ body: JSON.parse(raw) as Record<string, unknown>, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"ok":"fallback"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/v1`, seen);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
}

function claudeClient(): ModelClient {
  process.env.REVIEWPASS_BACKEND = 'claude-code';
  process.env.REVIEWPASS_CLAUDE_COMMAND = fakeClaude();
  process.env.REVIEWPASS_CLAUDE_TOKENS = 'tok-a\ntok-b';
  process.env.REVIEWPASS_CLAUDE_TOKEN_STATE = join(mkdtempSync(join(tmpdir(), 'claude-tokens-')), 'state.json');
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
  cfg.model.name = 'sonnet';
  cfg.model.reasoningEffort = 'low';
  return new ModelClient(cfg);
}

const ask = (c: ModelClient) =>
  c.json<{ ok: string }>([{ role: 'user', content: 'x' }], { type: 'object' }, { model: 'sonnet', reasoningEffort: 'high' });

test('with every token spent, the call goes to the fallback with its own model, effort and key', async () => {
  await withStub(async (base, seen) => {
    process.env.REVIEWPASS_FALLBACK_ENDPOINT = base;
    process.env.REVIEWPASS_FALLBACK_MODEL = 'z-ai/glm-5.3-flash';
    process.env.REVIEWPASS_FALLBACK_API_KEY = 'fb-key';
    process.env.REVIEWPASS_FALLBACK_REASONING_EFFORT = 'none';
    const client = claudeClient();

    process.env.SPENT = 'tok-a';
    assert.deepEqual((await ask(client)).value, { ok: 'tok-b' }, 'a free token is still used first');
    assert.equal(seen.length, 0);
    assert.equal(client.fallbackModel, undefined);

    process.env.SPENT = 'tok-a,tok-b';
    assert.deepEqual((await ask(client)).value, { ok: 'fallback' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.body.model, 'z-ai/glm-5.3-flash', 'the Claude model the call named is replaced');
    assert.equal(seen[0]!.body.reasoning_effort, 'none', 'and so is its effort');
    assert.equal(seen[0]!.auth, 'Bearer fb-key');
    assert.equal(client.fallbackModel, 'z-ai/glm-5.3-flash');
    assert.equal(client.usage.promptTokens, 7, 'the fallback call counts toward the review\'s usage');
  });
});

test('without a fallback, the limit error stands', async () => {
  const client = claudeClient();
  process.env.SPENT = 'tok-a,tok-b';
  await assert.rejects(ask(client), (e: unknown) => e instanceof ClaudeLimitError);
  assert.equal(client.fallbackModel, undefined);
});

test('a provider that is not a JSON object fails loudly instead of routing anywhere', async () => {
  process.env.REVIEWPASS_FALLBACK_ENDPOINT = 'http://127.0.0.1:9/v1';
  process.env.REVIEWPASS_FALLBACK_MODEL = 'm';
  process.env.REVIEWPASS_FALLBACK_PROVIDER = '["inceptron"]';
  const client = claudeClient();
  process.env.SPENT = 'tok-a,tok-b';
  await assert.rejects(ask(client), /REVIEWPASS_FALLBACK_PROVIDER must be a JSON object/);
});

test('the review says which model stood in for Claude', () => {
  const r: ReviewResult = {
    findings: [], walkthrough: '', fileGroups: [], effort: { score: 1, label: 'trivial' }, mergeRisk: 'low',
    checks: [], event: 'COMMENT', skipped: [], reviewedFiles: 2, failedFiles: 0, fallbackModel: 'z-ai/glm-5.3-flash',
  };
  assert.match(renderReviewSummary(r, []), /Claude was at its usage limit, so `z-ai\/glm-5\.3-flash` reviewed/);
  assert.doesNotMatch(renderReviewSummary({ ...r, fallbackModel: undefined }, []), /usage limit/);
});
