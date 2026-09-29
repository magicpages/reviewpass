/**
 * Findings listed in the review body instead of inline: visible, marked so the
 * next round does not raise them as new, and never summed up as a clean review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, FINDING_MARKER } from '../src/github/client.js';
import { renderCheckVerdict, renderReviewSummary, renderWalkthrough } from '../src/review/render.js';
import type { Finding, PullRequestContext, ReviewResult } from '../src/types.js';

const f = (title: string, fingerprint: string, over: Partial<Finding> = {}): Finding => ({
  path: 'a.ts', startLine: 3, endLine: 3, severity: 'minor', category: 'maintainability', title, body: 'b', fingerprint, ...over,
});
const result = (over: Partial<ReviewResult>): ReviewResult => ({
  findings: [], walkthrough: 'What changed.', fileGroups: [], effort: { score: 1, label: 'trivial' },
  mergeRisk: 'low', checks: [], event: 'COMMENT', skipped: [], reviewedFiles: 2, failedFiles: 0, ...over,
});
const pr: PullRequestContext = {
  owner: 'o', repo: 'r', number: 1, title: 't', body: '', author: 'a', baseSha: 'base000', headSha: 'head000',
  baseRef: 'main', files: [], reviewedFrom: 'base000', reviewedTo: 'head000', isIncremental: false, linkedIssues: [],
  closed: false, merged: false,
};

test('listed findings sit in a collapsed section, each carrying its marker', () => {
  const body = renderReviewSummary(result({
    findings: [f('Guard the list', 'aaa1', { category: 'correctness' })],
    listed: [f('Update the stale comment', 'bbb2'), f('Name the constant', 'ccc3')],
  }), []);
  assert.match(body, /<details>\n<summary>2 smaller points<\/summary>/);
  assert.ok(body.includes(`Update the stale comment <sub>(minor · maintainability)</sub> ${FINDING_MARKER('bbb2')}`));
  assert.ok(body.includes(FINDING_MARKER('ccc3')));
});

test('a finding outside the diff carries its marker too', () => {
  const outside = f('Fix the caller', 'ddd4', { category: 'correctness' });
  assert.ok(renderReviewSummary(result({ findings: [outside] }), [outside]).includes(FINDING_MARKER('ddd4')));
});

test('a review with only listed points is not "Nothing to raise"', () => {
  const r = result({ listed: [f('Update the stale comment', 'bbb2')] });
  assert.equal(renderWalkthrough(pr, r).split('\n')[3], '**Nothing that needs a comment.** 1 smaller point listed in the review.');
  assert.equal(renderCheckVerdict(r).title, '1 smaller point');
  assert.doesNotMatch(renderReviewSummary(r, []), /Nothing to raise/);
});

test('markers in review bodies count as already said', async () => {
  const client = new GitHubClient('t', 'o', 'r', 'reviewpass[bot]');
  const listReviewComments = Object.assign(() => {}, { kind: 'reviewComments' });
  const listReviews = Object.assign(() => {}, { kind: 'reviews' });
  const listComments = Object.assign(() => {}, { kind: 'issueComments' });
  const lists: Record<string, unknown[]> = {
    reviewComments: [{ body: `inline ${FINDING_MARKER('aaa1')}` }],
    reviews: [{ body: `- a ${FINDING_MARKER('bbb2')}\n- b ${FINDING_MARKER('ccc3')}` }, { body: null }],
    issueComments: [],
  };
  Object.assign(client as unknown as object, {
    kit: {
      paginate: async (fn: { kind?: string }) => lists[fn.kind ?? ''] ?? [],
      rest: { pulls: { listReviewComments, listReviews }, issues: { listComments } },
    },
    countOpenFindings: async () => 0,
  });
  const existing = await client.loadExistingReview(1);
  assert.deepEqual([...existing.fingerprints].sort(), ['aaa1', 'bbb2', 'ccc3']);
});
