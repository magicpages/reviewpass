/**
 * Verification can run on a different model than finding, and effort labels mean
 * different things across model families. The verify pass sends its own effort
 * when one is set, and the shared one otherwise.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelClient } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';
import { verify } from '../src/review/run.js';
import type { ChangedFile, Finding, ReviewUnit } from '../src/types.js';

afterEach(() => { delete process.env.REVIEWPASS_VERIFY_REASONING_EFFORT; });

const file: ChangedFile = {
  path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0,
  patch: '@@ -9,1 +10,1 @@\n+const total = items.length;', addedLines: [10],
};
const unit: ReviewUnit = { path: file.path, file, context: 'const total = items.length;', instructions: [], learnings: [], toolFindings: [] };
const finding: Finding = { path: 'src/a.ts', startLine: 10, endLine: 10, severity: 'major', category: 'correctness',
  title: 'Guard the empty list', body: 'items may be empty.' };

async function effortsSent(setup: (cfg: ReturnType<typeof loadConfig>) => void): Promise<unknown[]> {
  const sent: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      sent.push(JSON.parse(raw).reasoning_effort);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(
        { correct: true, in_scope: true, importance: 6, confidence: 0.8, reason: 'ok' }) } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
    cfg.model.endpoint = `http://127.0.0.1:${port}/v1`;
    cfg.model.endpoints = [cfg.model.endpoint];
    setup(cfg);
    await verify(new ModelClient(cfg), cfg, finding, unit);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return sent;
}

test('the verify pass sends its own effort when one is set', async () => {
  const sent = await effortsSent((cfg) => { cfg.model.reasoningEffort = 'low'; cfg.model.verifyReasoningEffort = 'none'; });
  assert.ok(sent.length > 0);
  assert.ok(sent.every((e) => e === 'none'), `sent ${JSON.stringify(sent)}`);
});

test('without one it keeps the shared effort', async () => {
  const sent = await effortsSent((cfg) => { cfg.model.reasoningEffort = 'low'; });
  assert.ok(sent.every((e) => e === 'low'), `sent ${JSON.stringify(sent)}`);
});

test('REVIEWPASS_VERIFY_REASONING_EFFORT is read and validated', () => {
  process.env.REVIEWPASS_VERIFY_REASONING_EFFORT = 'none';
  assert.equal(loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-'))).model.verifyReasoningEffort, 'none');
  process.env.REVIEWPASS_VERIFY_REASONING_EFFORT = 'maximum';
  assert.equal(loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-'))).model.verifyReasoningEffort, undefined,
    'an unknown label must not reach the request body');
});
