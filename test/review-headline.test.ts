/**
 * The first line of the walkthrough is what a reader takes as the verdict, so it
 * must never claim a clean review that did not happen. A run whose only file
 * failed rewrote a pull request's walkthrough to "Nothing to raise" while its
 * check went red; these pin every state that line can be in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCheckVerdict, renderReviewSummary, renderWalkthrough } from '../src/review/render.js';
import type { Finding, PullRequestContext, ReviewResult } from '../src/types.js';

const pr: PullRequestContext = {
  owner: 'o', repo: 'r', number: 1, title: 'a change', body: '', author: 'someone',
  baseSha: 'base000', headSha: 'head000', baseRef: 'main', files: [],
  reviewedFrom: 'base000', reviewedTo: 'head000', isIncremental: false, linkedIssues: [],
  closed: false, merged: false,
};
const finding: Finding = {
  path: 'a.ts', startLine: 1, endLine: 1, severity: 'major', category: 'correctness', title: 't', body: 'b',
};
const result = (over: Partial<ReviewResult>): ReviewResult => ({
  findings: [], walkthrough: 'What changed.', fileGroups: [], effort: { score: 1, label: 'trivial' },
  mergeRisk: 'low', checks: [], event: 'COMMENT', skipped: [], reviewedFiles: 1, failedFiles: 0, ...over,
});
const headline = (r: ReviewResult) => renderWalkthrough(pr, r).split('\n')[3];

test('a clean review says so', () => {
  assert.equal(headline(result({})), '**Nothing to raise.**');
});

test('a run whose only file failed is an incomplete review, not a clean one', () => {
  const r = result({ reviewedFiles: 0, failedFiles: 1 });
  assert.equal(headline(r), '**Incomplete review.** 1 of 1 file(s) failed; nothing was raised in the rest.');
  assert.doesNotMatch(renderWalkthrough(pr, r), /Nothing to raise/);
});

test('a partly failed run with no findings is incomplete too', () => {
  assert.equal(headline(result({ reviewedFiles: 3, failedFiles: 2 })),
    '**Incomplete review.** 2 of 5 file(s) failed; nothing was raised in the rest.');
});

test('findings from a partly failed run say what was not reviewed', () => {
  const r = result({ findings: [finding], reviewedFiles: 3, failedFiles: 2 });
  assert.equal(headline(r), '**1 finding.** 2 of 5 file(s) failed and were not reviewed.');
  assert.match(renderReviewSummary(r, []), /2 of 5 file\(s\) failed and were not reviewed/);
});

test('a blocked run says nothing was reviewed', () => {
  assert.equal(headline(result({ reviewedFiles: 0, failedFiles: 3, blocked: { message: 'The model account is out of credits.' } })),
    '**Nothing was reviewed.** The model account is out of credits.');
});

test('an incremental run with nothing new keeps the open findings in view', () => {
  assert.equal(headline(result({ openFindings: 12 })), '**Nothing new in these commits.** 12 earlier findings still open.');
});

test('the check title does not call a partly failed review clean', () => {
  assert.equal(renderCheckVerdict(result({ reviewedFiles: 3, failedFiles: 2 })).title, 'Incomplete review');
  assert.equal(renderCheckVerdict(result({ findings: [finding], reviewedFiles: 3, failedFiles: 2 })).title,
    '1 finding, 2 file(s) not reviewed');
  assert.equal(renderCheckVerdict(result({})).title, 'Nothing to raise');
});
