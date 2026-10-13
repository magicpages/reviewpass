/**
 * The pass over the whole change keeps only findings it can anchor: on a file
 * the change touched, near a changed line. They are recorded as their own sample.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelClient } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';
import { findInChange } from '../src/review/run.js';
import type { ChangedFile, PullRequestContext, ReviewUnit } from '../src/types.js';

const unit = (path: string, addedLines: number[]): ReviewUnit => {
  const file: ChangedFile = { path, status: 'modified', additions: addedLines.length, deletions: 0, patch: `@@ -1 +1 @@\n+changed ${path}`, addedLines };
  return { path, file, context: '', fileText: 'a\nb\nc', instructions: [], learnings: [], toolFindings: [] };
};
const pr = { number: 7, title: 'Scale services', body: 'Waits for convergence.' } as PullRequestContext;
const raw = (path: string, line: number, title: string) => ({
  path, start_line: line, end_line: line, severity: 'major', category: 'correctness', title, body: 'Why.',
  suggestion: '', siblings: [], settled_by: { path, line, quote: 'b' },
});

test('only findings on a changed file near a changed line survive, once each, as their own sample', async () => {
  let sent = '';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      sent = body;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ findings: [
        raw('src/deploy.ts', 10, 'Wait for the new replicas before reporting success'),
        raw('src/deploy.ts', 10, 'Wait for the new replicas before reporting success'),
        raw('src/elsewhere.ts', 3, 'A file the change did not touch'),
        raw('src/deploy.ts', 90, 'Far from any changed line'),
      ] }) } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
    cfg.model.endpoint = `http://127.0.0.1:${port}/v1`;
    cfg.model.endpoints = [cfg.model.endpoint];
    const out = await findInChange(new ModelClient(cfg), cfg, pr, [unit('src/deploy.ts', [9, 10, 11]), unit('src/other.ts', [1])], 4);
    assert.deepEqual(out.map((f) => [f.path, f.startLine, f.samples]), [['src/deploy.ts', 10, [4]]]);
    assert.equal(out[0]!.settledBy?.quote, 'b');
    assert.match(sent, /changed src\/other\.ts/, 'the whole diff is sent, every file in one request');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a large early diff cannot push later files out of the whole-change prompt', async () => {
  const { wholeChangePrompt } = await import('../src/review/run.js');
  const big = unit('src/big.ts', [1]);
  big.file.patch = `@@ -1 +1 @@\n${'+x\n'.repeat(200_000)}`;
  big.fileText = 'y\n'.repeat(200_000);
  const prompt = wholeChangePrompt(pr, [big, unit('src/late.ts', [1])], 120_000);
  assert.ok(prompt.length < 130_000, `prompt is ${prompt.length} chars`);
  assert.match(prompt, /### src\/late\.ts\n```diff\n@@ -1 \+1 @@\n\+changed src\/late\.ts/);
  assert.match(prompt, /### src\/late\.ts\n```\n1: a/);
});

test('a reply whose findings all lack a file is a failed pass, not an empty review', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const { path: _omit, ...noPath } = raw('src/deploy.ts', 10, 'No file named');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ findings: [noPath] }) } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
    cfg.model.endpoint = `http://127.0.0.1:${port}/v1`;
    cfg.model.endpoints = [cfg.model.endpoint];
    await assert.rejects(findInChange(new ModelClient(cfg), cfg, pr, [unit('src/deploy.ts', [10])], 4), /had no file/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
