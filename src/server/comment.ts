import * as github from '@actions/github';
import { apiBaseUrl } from '../github/auth.js';
import { parseCommand, HELP_TEXT, learningFromReply, type CommandName } from '../github/commands.js';
import { LearningStore } from '../store/learnings.js';
import { scopesFor } from '../store/common.js';

/**
 * Handling a comment on a pull request.
 *
 * This is the half of the system that makes it improve. Most durable review
 * knowledge originates from a maintainer replying to a
 * finding — replies are the training signal, not a convenience feature. A
 * reviewer that cannot be corrected raises the same wrong finding forever.
 */

type Octokit = ReturnType<typeof github.getOctokit>;

// Either name: comments posted before the rename must still be recognised.
const FINDING_RE = /<!-- (?:reviewpass|warren):finding:([a-f0-9]+) -->/;
const IGNORE_MARKER = '<!-- reviewpass:ignored -->';
const LEGACY_IGNORE_MARKER = '<!-- warren:ignored -->';

export interface CommentEvent {
  owner: string;
  repo: string;
  pr: number;
  token: string;
  /** Body of the comment that triggered this. */
  body: string;
  /** Set when the comment is a reply inside a review thread. */
  inReplyToId?: number;
  commentId?: number;
  author: string;
  /** Compute and store, but post nothing back to GitHub. */
  dryRun?: boolean;
}

export interface CommentOutcome {
  command: CommandName | 'none';
  action: string;
  triggersReview: boolean;
  fullReview: boolean;
}

export async function handleComment(
  ev: CommentEvent,
  store: LearningStore,
): Promise<CommentOutcome> {
  const cmd = parseCommand(ev.body);
  if (!cmd) return { command: 'none', action: 'not addressed to reviewpass', triggersReview: false, fullReview: false };

  const kit = github.getOctokit(ev.token, { baseUrl: apiBaseUrl() });
  const scope = `${ev.owner}/${ev.repo}`;

  switch (cmd.name) {
    case 'help':
      await reply(kit, ev, HELP_TEXT);
      return { command: cmd.name, action: 'posted help', triggersReview: false, fullReview: false };

    case 'review':
      return { command: cmd.name, action: 'review requested', triggersReview: true, fullReview: false };

    case 'full-review':
      return { command: cmd.name, action: 'full review requested', triggersReview: true, fullReview: true };

    case 'resolve': {
      const n = await resolveAll(kit, ev);
      await reply(kit, ev, `Resolved ${n} thread${n === 1 ? '' : 's'}.`);
      return { command: cmd.name, action: `resolved ${n} threads`, triggersReview: false, fullReview: false };
    }

    case 'ignore':
      await reply(kit, ev, `${IGNORE_MARKER}\nI will stop reviewing this pull request. Say \`@reviewpass resume\` to start again.`);
      return { command: cmd.name, action: 'ignoring this PR', triggersReview: false, fullReview: false };

    case 'resume':
      await reply(kit, ev, 'Reviewing again.');
      return { command: cmd.name, action: 'resumed', triggersReview: true, fullReview: false };

    case 'disagree':
    case 'agree': {
      // Only a reply inside a thread can be attached to a specific finding.
      const finding = ev.inReplyToId ? await findingForThread(kit, ev, ev.inReplyToId) : null;
      if (!finding) {
        // A general remark still becomes a repo-wide learning, just unanchored.
        store.add({
          scope, content: cmd.argument.slice(0, 600), source: ev.author, sourcePr: ev.pr,
        });
        await reply(kit, ev, 'Noted, and remembered for this repository.');
        return { command: cmd.name, action: 'stored a repo-wide learning', triggersReview: false, fullReview: false };
      }

      if (cmd.name === 'disagree') {
        store.recordRejection(scope, finding.fingerprint, finding.title, finding.path, cmd.argument.slice(0, 600));
        store.add({
          scope,
          path: finding.path,
          content: learningFromReply(cmd.argument, finding),
          source: ev.author,
          sourcePr: ev.pr,
        });
        await reply(kit, ev, 'Understood — I will not raise this again in this repository.');
        return { command: cmd.name, action: `rejected finding ${finding.fingerprint}`, triggersReview: false, fullReview: false };
      }

      store.add({
        scope,
        path: finding.path,
        content: learningFromReply(cmd.argument, finding),
        source: ev.author,
        sourcePr: ev.pr,
      });
      return { command: cmd.name, action: `learned from confirmation on ${finding.fingerprint}`, triggersReview: false, fullReview: false };
    }
  }
}

/** Reply in the thread when there is one, otherwise on the pull request. */
async function reply(kit: Octokit, ev: CommentEvent, body: string): Promise<void> {
  if (ev.dryRun) {
    console.log(`[dry run] would reply on ${ev.owner}/${ev.repo}#${ev.pr}: ${body.slice(0, 120)}`);
    return;
  }
  if (ev.inReplyToId) {
    await kit.rest.pulls.createReplyForReviewComment({
      owner: ev.owner, repo: ev.repo, pull_number: ev.pr,
      comment_id: ev.inReplyToId, body,
    });
    return;
  }
  await kit.rest.issues.createComment({
    owner: ev.owner, repo: ev.repo, issue_number: ev.pr, body,
  });
}

/** Walk back to the root comment of a thread to recover its finding marker. */
async function findingForThread(
  kit: Octokit, ev: CommentEvent, commentId: number,
): Promise<{ fingerprint: string; path: string; title: string } | null> {
  try {
    const { data } = await kit.rest.pulls.getReviewComment({
      owner: ev.owner, repo: ev.repo, comment_id: commentId,
    });
    const rootId = data.in_reply_to_id ?? data.id;
    const root = rootId === data.id
      ? data
      : (await kit.rest.pulls.getReviewComment({ owner: ev.owner, repo: ev.repo, comment_id: rootId })).data;

    const fp = FINDING_RE.exec(root.body ?? '')?.[1];
    if (!fp) return null;
    const title = /\*\*(.+?)\*\*/.exec(root.body ?? '')?.[1] ?? '(untitled finding)';
    return { fingerprint: fp, path: root.path, title };
  } catch {
    return null;
  }
}

async function resolveAll(kit: Octokit, ev: CommentEvent): Promise<number> {
  const query = `query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){ pullRequest(number:$number){
      reviewThreads(first:100){ nodes { id isResolved comments(first:1){ nodes { body } } } } } } }`;
  const data = await kit.graphql<{
    repository: { pullRequest: { reviewThreads: { nodes: {
      id: string; isResolved: boolean; comments: { nodes: { body: string }[] } }[] } } };
  }>(query, { owner: ev.owner, repo: ev.repo, number: ev.pr });

  let n = 0;
  for (const t of data.repository.pullRequest.reviewThreads.nodes) {
    if (t.isResolved) continue;
    if (!FINDING_RE.test(t.comments.nodes[0]?.body ?? '')) continue;
    if (ev.dryRun) { n++; continue; }
    await kit.graphql(
      `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id } } }`,
      { id: t.id },
    );
    n++;
  }
  return n;
}

/** Has someone told reviewpass to leave this pull request alone? */
export async function isIgnored(token: string, owner: string, repo: string, pr: number): Promise<boolean> {
  const kit = github.getOctokit(token, { baseUrl: apiBaseUrl() });
  const comments = await kit.paginate(kit.rest.issues.listComments, {
    owner, repo, issue_number: pr, per_page: 100,
  });
  let ignored = false;
  for (const c of comments) {
    // Either marker: a pull request paused before the rename stays paused.
    if (c.body?.includes(IGNORE_MARKER) || c.body?.includes(LEGACY_IGNORE_MARKER)) ignored = true;
    // A later `resume` lifts it.
    if (/@(?:reviewpass|warren)\s+resume/i.test(c.body ?? '')) ignored = false;
  }
  return ignored;
}

export { scopesFor };
