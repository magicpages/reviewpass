/**
 * A review in progress has to be visible on the pull request.
 *
 * A run started from a comment executes a workflow whose head is the default
 * branch, so it never joins the pull request's check suite — the page reads
 * "all checks have passed" while the review is still running. The check run is
 * the only surface that shows the work, and it must never be able to stop the
 * review: the App may not have `checks: write`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, actionsRunUrl } from '../src/github/client.js';
import { renderCheckVerdict } from '../src/review/render.js';

function clientWithChecks(createFails = false) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const client = new GitHubClient('t', 'o', 'r', 'reviewpass[bot]');
  (client as unknown as { kit: unknown }).kit = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: 'headsha123' } } }) },
      checks: {
        create: async (args: Record<string, unknown>) => {
          if (createFails) throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
          created.push(args);
          return { data: { id: 77 } };
        },
        update: async (args: Record<string, unknown>) => { updated.push(args); return { data: {} }; },
      },
    },
  };
  return { client, created, updated };
}

describe('the check run', () => {
  test('opens in progress against the head commit, and closes with the verdict', async () => {
    const { client, created, updated } = clientWithChecks();

    const sha = await client.headShaOf(1);
    assert.equal(sha, 'headsha123');

    const id = await client.startCheck(sha!, 'https://example.test/run/9');
    assert.equal(id, 77);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.head_sha, 'headsha123',
      'the check must sit on the pull request head, or it will not appear on the pull request');
    assert.equal(created[0]!.status, 'in_progress',
      'a check that starts completed shows nothing while the review runs');
    assert.equal(created[0]!.details_url, 'https://example.test/run/9');

    await client.finishCheck(id!, 'success', '2 findings', '3 file(s) reviewed, 0 failed.');
    assert.equal(updated.length, 1);
    assert.equal(updated[0]!.status, 'completed');
    assert.equal(updated[0]!.conclusion, 'success');
    assert.equal(updated[0]!.check_run_id, 77);
  });

  test('a missing checks:write permission does not stop the review', async () => {
    const { client } = clientWithChecks(true);
    // Must resolve, not reject: the caller treats undefined as "no check to close"
    // and reviews anyway. A throw here would fail the whole job over a status line.
    const id = await client.startCheck('headsha123');
    assert.equal(id, undefined);
  });
});

describe('actionsRunUrl', () => {
  test('points at this run inside Actions, and at nothing outside it', () => {
    const saved = { ...process.env };
    try {
      process.env.GITHUB_SERVER_URL = 'https://github.com';
      process.env.GITHUB_REPOSITORY = 'magicpages/customer-portal';
      process.env.GITHUB_RUN_ID = '12345';
      assert.equal(actionsRunUrl(),
        'https://github.com/magicpages/customer-portal/actions/runs/12345');

      delete process.env.GITHUB_RUN_ID;
      assert.equal(actionsRunUrl(), undefined);
    } finally {
      process.env = saved;
    }
  });
});

describe('how a finished review closes its check', () => {
  const base = {
    findings: [], fileGroups: [], checks: [], skipped: [],
    effort: { score: 1, label: 'Trivial' }, mergeRisk: 'minimal', event: 'COMMENT',
    walkthrough: '',
  } as unknown as Parameters<typeof renderCheckVerdict>[0];
  const result = (over: Record<string, unknown>) =>
    renderCheckVerdict({ ...base, ...over } as Parameters<typeof renderCheckVerdict>[0]);

  test('never closes green over a pull request nothing read', () => {
    // Every file failed. The job calls setFailed here, so a green check would
    // put a passing tick on code no model looked at.
    const v = result({ reviewedFiles: 0, failedFiles: 12 });
    assert.equal(v.conclusion, 'failure');
    assert.match(v.title, /No file could be reviewed/);
  });

  test('a blocked run is not the author\'s fault, so it is not red', () => {
    const v = result({ blocked: { message: 'The model endpoint could not be reached.' }, failedFiles: 3 });
    assert.equal(v.conclusion, 'neutral');
    assert.match(v.summary, /could not be reached/);
  });

  test('nothing reviewable is neutral, not a pass and not a failure', () => {
    const v = result({ reviewedFiles: 0, failedFiles: 0 });
    assert.equal(v.conclusion, 'neutral');
  });

  test('a real review passes, and says what it found', () => {
    assert.deepEqual(
      { c: result({ reviewedFiles: 4, failedFiles: 0 }).conclusion,
        t: result({ reviewedFiles: 4, failedFiles: 0 }).title },
      { c: 'success', t: 'Nothing to raise' },
    );
    const two = result({ reviewedFiles: 4, failedFiles: 1, findings: [{}, {}] });
    assert.equal(two.conclusion, 'success');
    assert.equal(two.title, '2 findings');
    assert.match(two.summary, /4 file\(s\) reviewed, 1 failed/);
  });
});
