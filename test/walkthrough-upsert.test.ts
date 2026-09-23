/**
 * One walkthrough comment per pull request, not one per upsert.
 *
 * A run posts the progress note first and its result second. If the second
 * write cannot identify the first comment, the pull request gets two:
 * "Reviewing this pull request" stranded above the review meant to replace it.
 *
 * There are three ways to lose track of it, and each has a test here: no id
 * passed at all, an id that exists beyond the first page of comments, and a
 * comment too freshly written for the listing to show.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github/client.js';
import { renderProgressNotice } from '../src/review/render.js';

const WALKTHROUGH = '<!-- reviewpass:walkthrough -->';

interface Opts {
  /** Comments the list reports before the run starts. */
  existing?: { id: number; body: string }[];
  /** Eventual consistency: what this run writes is not visible to the listing. */
  hideNewFromList?: boolean;
}

function clientRecordingComments({ existing = [], hideNewFromList = false }: Opts = {}) {
  const comments = [...existing];
  const visible = [...existing];
  let nextId = 1000;
  const calls = { created: 0, updated: 0 };

  const client = new GitHubClient('t', 'o', 'r', 'reviewpass[bot]');
  const listComments = Object.assign(() => {}, { kind: 'issueComments' });
  (client as unknown as { kit: unknown }).kit = {
    // Octokit's paginate walks every page; the stub hands back the whole list.
    paginate: async (fn: unknown) =>
      (fn as { kind?: string })?.kind === 'issueComments' ? visible : [],
    rest: {
      issues: {
        listComments,
        createComment: async ({ body }: { body: string }) => {
          calls.created++;
          const c = { id: nextId++, body };
          comments.push(c);
          if (!hideNewFromList) visible.push(c);
          return { data: c };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          calls.updated++;
          const c = comments.find((x) => x.id === comment_id);
          assert.ok(c, `updated comment ${comment_id}, which does not exist`);
          c.body = body;
          return { data: c };
        },
      },
    },
  };
  return { client, comments, calls };
}

const progress = () => renderProgressNotice(
  { headSha: 'aaaaaaa' }, { kind: 'started', files: 16, incremental: false },
);
const result = () => renderProgressNotice(
  { headSha: 'aaaaaaa' }, { kind: 'blocked', message: 'The model endpoint could not be reached.' },
);

describe('upsertWalkthrough', () => {
  test('replaces the progress note instead of posting beside it', async () => {
    const { client, comments, calls } = clientRecordingComments();

    // The order a run uses, with no id carried between the calls — the case on
    // a pull request being reviewed for the first time.
    await client.upsertWalkthrough(1, progress());
    await client.upsertWalkthrough(1, result());

    assert.equal(comments.length, 1,
      'a pull request must end up with one walkthrough comment, not one per run step');
    assert.equal(calls.created, 1);
    assert.equal(calls.updated, 1);
    assert.match(comments[0]!.body, /could not be reached/,
      'the surviving comment must be the result, not the progress note');
  });

  test('finds a walkthrough that sits past the first page of comments', async () => {
    // A busy pull request: the listing's first page is the oldest hundred, so a
    // walkthrough behind them is invisible to a single-page lookup.
    const existing = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      body: i === 130 ? `${WALKTHROUGH}\n<!-- reviewpass:reviewing:aaaaaaa -->` : `chatter ${i}`,
    }));
    const { client, comments, calls } = clientRecordingComments({ existing });

    await client.upsertWalkthrough(1, result());

    assert.equal(calls.created, 0, 'the existing walkthrough must be found, not duplicated');
    assert.equal(calls.updated, 1);
    assert.equal(comments.length, 150);
    assert.match(comments[130]!.body, /could not be reached/);
  });

  test('uses the id from its own first write when the listing cannot see it yet', async () => {
    // The comment is created but the listing has not caught up. Relying on the
    // lookup here would post a second comment.
    const { client, comments, calls } = clientRecordingComments({ hideNewFromList: true });

    const id = await client.upsertWalkthrough(1, progress());
    assert.ok(id, 'the write must report which comment it wrote');

    await client.upsertWalkthrough(1, result(), id);

    assert.equal(calls.created, 1, 'the id from the first write must prevent a second comment');
    assert.equal(calls.updated, 1);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /could not be reached/);
  });
});
