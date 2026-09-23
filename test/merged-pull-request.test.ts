/**
 * A review must stop when its pull request is already done with.
 *
 * On one card a review runs tens of minutes, so a pull request can land before
 * its turn comes up or a minute into the run. reviewpass#16 merged at 14:38 and
 * the review of it kept working until 15:05, then posted six findings onto code
 * already in main — while seven reviews waited behind it for the same slot.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github/client.js';

function client(pull: Record<string, unknown>, getThrows = false) {
  const c = new GitHubClient('t', 'o', 'r', 'reviewpass[bot]');
  const file = (filename: string) => ({
    filename, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x',
  });
  (c as unknown as { kit: unknown }).kit = {
    paginate: async (fn: unknown) => {
      const kind = (fn as { kind?: string })?.kind;
      return kind === 'files' ? [file('src/a.ts')] : [];
    },
    rest: {
      pulls: {
        get: async () => {
          if (getThrows) throw new Error('502 from GitHub');
          return { data: {
            number: 1, title: 't', body: '', user: { login: 'someone' },
            base: { sha: 'base000', ref: 'main' }, head: { sha: 'head999', ref: 'branch' },
            ...pull,
          } };
        },
        listFiles: Object.assign(() => {}, { kind: 'files' }),
        listReviewComments: Object.assign(() => {}, { kind: 'reviewComments' }),
      },
      issues: { listComments: Object.assign(() => {}, { kind: 'issueComments' }) },
      repos: { compareCommitsWithBasehead: async () => ({ data: { files: [] } }) },
    },
  };
  return c;
}

describe('reading a pull request that is already closed', () => {
  test('carries the state the review has to act on', async () => {
    const merged = await client({ state: 'closed', merged_at: '2026-09-23T14:38:53Z' })
      .loadPullRequest(1, {} as never);
    assert.equal(merged.closed, true);
    assert.equal(merged.merged, true, 'a merged pull request must be distinguishable from an abandoned one');

    const abandoned = await client({ state: 'closed', merged_at: null })
      .loadPullRequest(1, {} as never);
    assert.equal(abandoned.closed, true);
    assert.equal(abandoned.merged, false);

    const open = await client({ state: 'open', merged_at: null }).loadPullRequest(1, {} as never);
    assert.equal(open.closed, false);
  });
});

describe('isStillOpen, asked again part-way through a review', () => {
  test('says no once the pull request has landed', async () => {
    assert.equal(await client({ state: 'closed', merged_at: '2026-09-23T14:38:53Z' }).isStillOpen(1), false);
    assert.equal(await client({ state: 'open' }).isStillOpen(1), true);
  });

  test('says yes when it cannot tell', async () => {
    // Losing a finished review to a failed status call is the worse mistake,
    // so an unanswered question must not stop the run.
    assert.equal(await client({}, true).isStillOpen(1), true);
  });
});
