/**
 * Ollama Cloud accepts the findings schema without enforcing it.
 *
 * Measured against `deepseek-v4.1-flash:1017` on a real pull request: 13 of 13
 * files came back as a bare finding object instead of `{ findings: [...] }`,
 * or with `line`/`lines` instead of `start_line`/`end_line`, and `settled_by`
 * as the quote string. Every reply was rejected, so the review posted nothing
 * and the check failed — a review that read the code and reported an outage.
 *
 * These replies are placeable; only the keys differ. The translation is pinned
 * here, together with the guard that a reply carrying nothing placeable still
 * fails the file rather than counting as clean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelClient } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';
import { findInFile } from '../src/review/run.js';
import type { ChangedFile, PullRequestContext, ReviewUnit } from '../src/types.js';

/** A stub endpoint that answers every request with the same content. */
async function withReply(content: string, fn: (base: string) => Promise<void>) {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function config(endpoint: string) {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
  cfg.model.endpoint = endpoint;
  cfg.model.endpoints = [endpoint];
  cfg.review.findSamples = 1;
  return cfg;
}

const file: ChangedFile = {
  path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0,
  patch: '@@ -9,1 +10,1 @@\n+const total = items.length;', addedLines: [10],
};
const unit: ReviewUnit = {
  path: file.path, file, context: '', instructions: [], learnings: [], toolFindings: [],
};
const pr: PullRequestContext = {
  owner: 'o', repo: 'r', number: 1, title: 'a change', body: '', author: 'someone',
  baseSha: 'base', headSha: 'head', baseRef: 'main', files: [file],
  reviewedFrom: 'base', reviewedTo: 'head', isIncremental: false, linkedIssues: [],
  closed: false, merged: false,
};

test('a bare finding object is read as a one-finding reply', async () => {
  const reply = JSON.stringify({
    start_line: 10, end_line: 10, severity: 'high', category: 'bug',
    title: 'Check the count', body: 'The total may be off by one.',
  });
  await withReply(reply, async (base) => {
    const cfg = config(base);
    const found = await findInFile(new ModelClient(cfg), cfg, pr, unit);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.title, 'Check the count');
    assert.deepEqual([found[0]!.severity, found[0]!.category], ['major', 'correctness']);
  });
});

test('line and lines are mapped to the schema\'s start_line and end_line', async () => {
  const reply = JSON.stringify([
    { line: 10, title: 'Check the count', body: 'The total may be off by one.' },
    { lines: '11-12', title: 'Guard the empty list', body: 'items may be empty.' },
  ]);
  await withReply(reply, async (base) => {
    const cfg = config(base);
    const found = await findInFile(new ModelClient(cfg), cfg, pr, unit);
    const byTitle = new Map(found.map((f) => [f.title, f]));
    assert.deepEqual(
      [byTitle.get('Check the count')?.startLine, byTitle.get('Check the count')?.endLine],
      [10, 10],
    );
    assert.deepEqual(
      [byTitle.get('Guard the empty list')?.startLine, byTitle.get('Guard the empty list')?.endLine],
      [11, 12],
    );
  });
});

test('a quote string becomes the citation the evidence gate checks', async () => {
  const reply = JSON.stringify({
    start_line: 10, end_line: 10,
    title: 'Check the count', body: 'The total may be off by one.',
    settled_by: 'const total = items.length;',
  });
  await withReply(reply, async (base) => {
    const cfg = config(base);
    const found = await findInFile(new ModelClient(cfg), cfg, pr, unit);
    assert.deepEqual(found[0]!.settledBy, {
      path: 'src/a.ts', line: 10, quote: 'const total = items.length;',
    });
  });
});

test('an object with nothing placeable still fails the file', async () => {
  await withReply('{"summary":"Nothing to report."}', async (base) => {
    const cfg = config(base);
    await assert.rejects(
      findInFile(new ModelClient(cfg), cfg, pr, unit),
      /no findings array/,
    );
  });
});
