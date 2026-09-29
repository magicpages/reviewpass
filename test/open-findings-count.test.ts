/**
 * "N earlier findings still open" must count what is open after this review,
 * and must reach what is posted - including on an update with nothing to review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, type ReviewSource } from '../src/pipeline.js';
import { FileLearningStore } from '../src/store/file-learnings.js';
import type { ChangedFile, PullRequestContext } from '../src/types.js';

const file: ChangedFile = {
  path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0,
  patch: '@@ -1,1 +1,2 @@\n const a = 1;\n+const total = items.length;', addedLines: [2],
};
const pr = (files: ChangedFile[]): PullRequestContext => ({
  owner: 'o', repo: 'r', number: 1, title: 'a change', body: 'Adds a total.', author: 'someone',
  baseSha: 'base000', headSha: 'head000', baseRef: 'main', files,
  reviewedFrom: 'base000', reviewedTo: 'head000', isIncremental: true, linkedIssues: [],
  closed: false, merged: false,
});

/** A pull request source that records what was posted. */
function source(files: ChangedFile[], openFindings: number, resolves: number) {
  const posted: { reviews: string[]; walkthroughs: string[] } = { reviews: [], walkthroughs: [] };
  const src: ReviewSource = {
    loadPullRequest: async () => pr(files),
    loadExistingReview: async () => ({
      fingerprints: new Set(['old1', 'old2', 'old3']), lastReviewedSha: 'base000', walkthroughCommentId: 7, openFindings,
    }),
    planComments: (findings) => ({ anchored: findings.map((f) => ({ finding: f, line: f.startLine })), unanchored: [] }),
    currentHeadSha: async () => 'head000',
    submitReview: async (_n, _sha, _plan, body) => { posted.reviews.push(body); return { posted: 0, degraded: false }; },
    upsertWalkthrough: async (_n, body) => { posted.walkthroughs.push(body); return 7; },
    resolveThreads: async () => resolves,
    dismissStaleReviews: async () => 0,
    isStillOpen: async () => true,
    renewAuth: async () => false,
  };
  return { src, posted };
}

async function withModel(fn: (endpoint: string) => Promise<void>) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"findings":[]}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}/v1`); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

async function run(files: ChangedFile[], openFindings: number, resolves: number) {
  const workspace = mkdtempSync(join(tmpdir(), 'reviewpass-ws-'));
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src/a.ts'), 'const a = 1;\nconst total = items.length;\n');
  const { src, posted } = source(files, openFindings, resolves);
  await withModel((endpoint) => runReview({
    source: src, token: '', owner: 'o', repo: 'r', prNumber: 1, workspace,
    store: new FileLearningStore(join(workspace, 'learnings.json')),
    configOverrides: { endpoint, endpoints: [endpoint] },
    log: { info: () => {}, warn: () => {} },
  }).then(() => undefined));
  return posted;
}

test('an update with nothing reviewable still says what is open, in the review and the walkthrough', async () => {
  const posted = await run([], 3, 0);
  assert.match(posted.reviews.at(-1) ?? '', /3 earlier findings still open above/);
  assert.match(posted.walkthroughs.at(-1) ?? '', /\*\*No new findings\.\*\* 3 earlier findings still open\./);
});

test('findings this review resolves are not counted as still open', async () => {
  const posted = await run([file], 3, 2);
  assert.match(posted.reviews.at(-1) ?? '', /1 earlier finding still open above/);
  assert.match(posted.walkthroughs.at(-1) ?? '', /1 earlier finding still open/);
});
