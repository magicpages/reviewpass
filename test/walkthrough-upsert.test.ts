/**
 * One walkthrough comment per pull request, not one per upsert.
 *
 * A run posts the progress note first and its result second. The id of the
 * comment the first call created is not carried to the second, so unless the
 * upsert looks the comment up, the pull request gets two: "Reviewing this pull
 * request" stranded above the review that was supposed to replace it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github/client.js';
import { renderProgressNotice } from '../src/review/render.js';

function clientRecordingComments() {
  const comments: { id: number; body: string }[] = [];
  let nextId = 100;
  const calls = { created: 0, updated: 0 };

  const client = new GitHubClient('t', 'o', 'r', 'reviewpass[bot]');
  (client as unknown as { kit: unknown }).kit = {
    rest: {
      issues: {
        listComments: async () => ({ data: comments }),
        createComment: async ({ body }: { body: string }) => {
          calls.created++;
          comments.push({ id: nextId++, body });
          return { data: comments.at(-1) };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          calls.updated++;
          const c = comments.find((x) => x.id === comment_id);
          assert.ok(c, 'updated a comment that does not exist');
          c.body = body;
          return { data: c };
        },
      },
    },
  };
  return { client, comments, calls };
}

describe('upsertWalkthrough', () => {
  test('replaces the progress note instead of posting beside it', async () => {
    const { client, comments, calls } = clientRecordingComments();

    // Exactly the order a run uses, and with no id carried between them —
    // which is the case on a pull request reviewed for the first time.
    await client.upsertWalkthrough(1, renderProgressNotice(
      { headSha: 'aaaaaaa' }, { kind: 'started', files: 16, incremental: false },
    ));
    await client.upsertWalkthrough(1, renderProgressNotice(
      { headSha: 'aaaaaaa' }, { kind: 'blocked', message: 'The model endpoint could not be reached.' },
    ));

    assert.equal(comments.length, 1,
      'a pull request must end up with one walkthrough comment, not one per run step');
    assert.equal(calls.created, 1);
    assert.equal(calls.updated, 1);
    assert.match(comments[0]!.body, /could not be reached/,
      'the surviving comment must be the result, not the progress note');
  });
});
