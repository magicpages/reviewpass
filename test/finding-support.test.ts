/**
 * How many find samples raised a finding survives every merge, so a filter can
 * weigh a defect several samples agreed on against one a single sample produced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelClient } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';
import { collapseNearDuplicates, findInFile } from '../src/review/run.js';
import type { ChangedFile, Finding, PullRequestContext, ReviewUnit } from '../src/types.js';

const file: ChangedFile = {
  path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0,
  patch: '@@ -9,1 +10,1 @@\n+const total = items.length;', addedLines: [10],
};
const unit: ReviewUnit = { path: file.path, file, context: '', instructions: [], learnings: [], toolFindings: [] };
const pr: PullRequestContext = {
  owner: 'o', repo: 'r', number: 1, title: 'a change', body: '', author: 'someone',
  baseSha: 'base', headSha: 'head', baseRef: 'main', files: [file],
  reviewedFrom: 'base', reviewedTo: 'head', isIncremental: false, linkedIssues: [],
  closed: false, merged: false,
};
const f = (title: string) => ({ start_line: 10, end_line: 10, severity: 'major', category: 'correctness', title, body: 'items may be empty.' });

test('a finding raised by two of three samples records both', async () => {
  // sample 0 and 2 find the guard; sample 1 finds something else.
  const replies = [[f('Guard the empty list')], [f('Name the magic number')], [f('Guard the empty list')]];
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: replies[n++] ?? [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
    cfg.model.endpoint = `http://127.0.0.1:${port}/v1`;
    cfg.model.endpoints = [cfg.model.endpoint];
    cfg.review.findSamples = 3;
    const found = await findInFile(new ModelClient(cfg), cfg, pr, unit);
    const by = Object.fromEntries(found.map((x) => [x.title, x.samples]));
    assert.deepEqual(by, { 'Guard the empty list': [0, 2], 'Name the magic number': [1] });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('collapsing near-duplicates keeps the union of their samples', () => {
  const base: Finding = { path: 'src/a.ts', startLine: 10, endLine: 10, severity: 'major', category: 'correctness',
    title: 'Guard the empty items list before reading its length', body: 'Reading the length of an empty items list fails.' };
  const [one, ...rest] = collapseNearDuplicates([
    { ...base, samples: [0] },
    { ...base, title: 'Guard the empty items list before reading the length', samples: [3] },
  ]);
  assert.equal(rest.length, 0, 'the two phrasings should collapse into one finding');
  assert.deepEqual(one!.samples, [0, 3]);
});
