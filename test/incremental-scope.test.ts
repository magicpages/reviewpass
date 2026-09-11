/**
 * The wiring, not just the helper.
 *
 * `narrowToPullRequest` has its own unit tests, and they would all keep passing
 * if the call to it were deleted from `loadPullRequest`. That is the regression
 * worth catching: the fifty-file review happened because the incremental branch
 * used the wrong set, not because the intersection was computed wrongly.
 *
 * The Octokit is replaced with the smallest object the method actually reads.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github/client.js';

const PR_FILES = ['src/mine.ts', 'src/mine-too.ts'];
const SINCE_LAST_REVIEW = ['src/mine.ts', 'src/from-a-base-update.ts', 'src/also-theirs.ts'];

function clientWithStubbedApi() {
  const client = new GitHubClient('t', 'o', 'r', 'reviewpass[bot]');
  const file = (filename: string) => ({
    filename, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x',
  });

  const stub = {
    paginate: async (fn: unknown, _opts: unknown) => {
      // Which paginated call this is, by the marker the stub below carries.
      const kind = (fn as { kind?: string })?.kind;
      if (kind === 'files') return PR_FILES.map(file);
      if (kind === 'reviewComments') {
        // One prior finding, so a last-reviewed sha is recorded.
        return [{ id: 1, path: 'src/mine.ts', line: 1, body: '<!-- reviewpass:fp:abc123 -->' }];
      }
      if (kind === 'issueComments') {
        return [{ id: 2, body: '<!-- reviewpass:walkthrough --> <!-- reviewpass:sha:aaaaaaa -->' }];
      }
      return [];
    },
    rest: {
      pulls: {
        get: async () => ({ data: {
          number: 1, title: 't', body: '', user: { login: 'someone' },
          base: { sha: 'base000', ref: 'main' }, head: { sha: 'head999', ref: 'branch' },
        } }),
        listFiles: Object.assign(() => {}, { kind: 'files' }),
        listReviewComments: Object.assign(() => {}, { kind: 'reviewComments' }),
      },
      issues: { listComments: Object.assign(() => {}, { kind: 'issueComments' }) },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: {
          files: SINCE_LAST_REVIEW.map(file),
        } }),
      },
    },
  };
  (client as unknown as { kit: unknown }).kit = stub;
  return client;
}

describe('loadPullRequest on an incremental run', () => {
  test('reviews only files the pull request itself changed', async () => {
    const client = clientWithStubbedApi();
    let pr;
    try {
      pr = await client.loadPullRequest(1, { incremental: true } as never);
    } catch (err) {
      // The stub covers what this path reads; anything else is a real signal
      // that the method now needs more, which is worth knowing about.
      assert.fail(`loadPullRequest needed more of the API than the stub provides: ${String(err).slice(0, 200)}`);
    }
    const paths = pr!.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['src/mine.ts'],
      'a file that arrived with a base update must not be reviewed');
  });
});
