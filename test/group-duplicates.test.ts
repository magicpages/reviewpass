/**
 * A finding the group verifier names as another's duplicate is dropped only in
 * favour of a finding that is posted. Folded into a neighbour the verifier then
 * refuted, a real defect used to disappear with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelClient } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';
import { verifyGroup } from '../src/review/run.js';
import type { ChangedFile, Finding, ReviewUnit } from '../src/types.js';

const file: ChangedFile = {
  path: 'src/a.ts', status: 'modified', additions: 3, deletions: 0,
  patch: '@@ -9,1 +10,3 @@\n+a\n+b\n+c', addedLines: [10, 11, 12],
};
const unit: ReviewUnit = { path: file.path, file, context: 'a\nb\nc', instructions: [], learnings: [], toolFindings: [] };
const finding = (n: number, samples: number[]): Finding => ({
  path: 'src/a.ts', startLine: 10, endLine: 12, severity: 'minor', category: 'correctness',
  title: `Finding ${n}`, body: `Body ${n}.`, samples,
});

type Verdict = { index: number; correct: boolean; in_scope: boolean; importance: number; duplicate_of: number; reason: string };

async function judge(verdicts: Verdict[], findings: Finding[]): Promise<Finding[]> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdicts }) } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
    cfg.model.endpoint = `http://127.0.0.1:${port}/v1`;
    cfg.model.endpoints = [cfg.model.endpoint];
    return await verifyGroup(new ModelClient(cfg), cfg, findings, unit);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const v = (index: number, correct: boolean, duplicate_of = -1): Verdict =>
  ({ index, correct, in_scope: true, importance: 5, duplicate_of, reason: `reason ${index}` });

test('a duplicate of a posted finding is dropped, and its samples go to that finding', async () => {
  const out = await judge([v(0, true), v(1, true, 0)], [finding(0, [0]), finding(1, [2, 3])]);
  assert.equal(out[0]!.verdict, 'upheld');
  assert.deepEqual(out[0]!.samples, [0, 2, 3]);
  assert.equal(out[1]!.verdict, 'refuted');
  assert.match(out[1]!.verdictReason!, /^duplicate of finding 0/);
});

test('a duplicate of a refuted finding stands on its own verdict', async () => {
  const out = await judge([v(0, false), v(1, true, 0)], [finding(0, [0]), finding(1, [1])]);
  assert.equal(out[0]!.verdict, 'refuted');
  assert.equal(out[1]!.verdict, 'upheld', 'a real defect must not go down with the finding it was folded into');
});

test('a duplicate of a refuted finding that is itself wrong stays refuted, as incorrect', async () => {
  const out = await judge([v(0, false), v(1, false, 0)], [finding(0, [0]), finding(1, [1])]);
  assert.equal(out[1]!.verdict, 'refuted');
  assert.match(out[1]!.verdictReason!, /^incorrect/);
});

test('a chain of duplicates folds into the finding at its end', async () => {
  const out = await judge([v(0, true), v(1, true, 0), v(2, true, 1)], [finding(0, [0]), finding(1, [1]), finding(2, [3])]);
  assert.deepEqual(out.map((f) => f.verdict), ['upheld', 'refuted', 'refuted']);
  assert.deepEqual(out[0]!.samples, [0, 1, 3]);
});

test('two findings named as each other\'s duplicate keep one of them', async () => {
  const out = await judge([v(0, true, 1), v(1, true, 0)], [finding(0, [0]), finding(1, [1])]);
  assert.deepEqual(out.map((f) => f.verdict), ['refuted', 'upheld']);
  assert.deepEqual(out[1]!.samples, [0, 1]);
});
