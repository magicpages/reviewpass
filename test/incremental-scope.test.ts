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
import { renderProgressNotice } from '../src/review/render.js';

const PR_FILES = ['src/mine.ts', 'src/mine-too.ts'];
const SINCE_LAST_REVIEW = ['src/mine.ts', 'src/from-a-base-update.ts', 'src/also-theirs.ts'];

const FINISHED_WALKTHROUGH = '<!-- reviewpass:walkthrough --> <!-- reviewpass:sha:aaaaaaa -->';

function clientWithStubbedApi(walkthroughBody: string = FINISHED_WALKTHROUGH) {
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
        return [{ id: 2, body: walkthroughBody }];
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

describe('a run that was cancelled before it reviewed anything', () => {
  test('does not let its progress note stand in for a review', async () => {
    // Exactly what the cancelled run left behind on customer-portal#3279: the
    // note it posts before doing any work. The run after it read that as
    // "ce889b0 is reviewed", diffed from there, and approved a 29-file pull
    // request having looked at one file.
    const started = renderProgressNotice(
      { headSha: 'aaaaaaa' },
      { kind: 'started', files: 2, incremental: false },
    );

    const client = clientWithStubbedApi(started);
    const pr = await client.loadPullRequest(1, { incremental: true } as never);

    assert.equal(pr.isIncremental, false,
      'a note saying a review started must not be read as a review that finished');
    assert.deepEqual(pr.files.map((f) => f.path).sort(), [...PR_FILES].sort(),
      'the whole pull request must be reviewed, not just the last push');
  });
});
