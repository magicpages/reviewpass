import { envAny } from './config/index.js';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolveIdentity } from './github/auth.js';
import { runReview } from './pipeline.js';

/**
 * The Action.
 *
 * Two modes:
 *
 *  - **daemon** (default when `daemon-url` is set): post the job to the daemon on
 *    the runner host and print what it did. The daemon owns the mirror, the
 *    database and the model, so nothing has to be checked out or cached here.
 *  - **standalone**: run the whole pipeline inside the job, using the checkout
 *    the workflow already made. Slower and stateless, but works anywhere.
 */

interface DaemonResult {
  event: string;
  findings: number;
  candidates: number;
  refuted: number;
  posted: number;
  unanchored: number;
  resolved: number;
  effort: { score: number; label: string };
  mergeRisk: string;
  usage: { promptTokens: number; completionTokens: number };
  titles: string[];
  error?: string;
}

async function viaDaemon(url: string, token: string, prNumber: number): Promise<void> {
  const ctx = github.context;
  const body = {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    pr: prNumber,
    token,
    fullReview: core.getInput('full-review') === 'true',
    profile: core.getInput('profile') || undefined,
    model: core.getInput('model') || undefined,
  };

  const secret = core.getInput('daemon-token') || envAny('TOKEN');
  const res = await fetch(`${url.replace(/\/$/, '')}/review`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`daemon returned ${res.status}: ${text.slice(0, 400)}`);

  const result = JSON.parse(text) as DaemonResult;
  if (result.error) throw new Error(result.error);

  for (const t of result.titles) core.info(`  ${t}`);
  core.info(
    `${result.findings} finding(s) from ${result.candidates} candidates ` +
    `(${result.refuted} refuted), ${result.posted} posted inline, ` +
    `${result.resolved} threads resolved. Verdict ${result.event}. ` +
    `Tokens: ${result.usage.promptTokens} in / ${result.usage.completionTokens} out.`,
  );
  core.setOutput('findings', String(result.findings));
  core.setOutput('event', result.event);
}

async function standalone(token: string, prNumber: number, selfLogin?: string): Promise<void> {
  const ctx = github.context;
  const profile = core.getInput('profile');
  const outcome = await runReview({
    token,
    selfLogin,
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    prNumber,
    workspace: core.getInput('workspace') || process.env.GITHUB_WORKSPACE || process.cwd(),
    fullReview: core.getInput('full-review') === 'true',
    configOverrides: {
      endpoint: core.getInput('model-endpoint') || undefined,
      name: core.getInput('model') || undefined,
      profile: profile === 'chill' || profile === 'assertive' ? profile : undefined,
    },
    log: { info: (m) => core.info(m), warn: (m) => core.warning(m) },
  });

  core.info(
    `Done: ${outcome.posted} inline, ${outcome.plan.unanchored.length} in summary, ` +
    `${outcome.resolved} threads resolved, verdict ${outcome.result.event}. ` +
    `Tokens: ${outcome.usage.promptTokens} in / ${outcome.usage.completionTokens} out.`,
  );
  core.setOutput('findings', String(outcome.result.findings.length));
  core.setOutput('event', outcome.result.event);
  core.setOutput('reviewed-files', String(outcome.result.reviewedFiles ?? 0));
  core.setOutput('failed-files', String(outcome.result.failedFiles ?? 0));

  // A blocked run is surfaced on the pull request, not as a failed check.
  //
  // The reason is always something the person who opened the pull request
  // cannot fix — an exhausted account, a rejected key, an endpoint that is
  // down — so failing their check blames them for it. The notice on the review
  // is what makes it visible; this warning is for whoever reads the job.
  if (outcome.result.blocked) {
    core.warning(`reviewpass did not review anything: ${outcome.result.blocked.message}`);
  } else if ((outcome.result.failedFiles ?? 0) > 0 && (outcome.result.reviewedFiles ?? 0) === 0) {
    // Not a recognised blocker: something broke that should be looked at.
    core.setFailed(`No file could be reviewed: all ${outcome.result.failedFiles} failed.`);
  }
}

/** A comment event is a conversation turn, not a review trigger. */
async function commentViaDaemon(url: string, token: string, prNumber: number): Promise<boolean> {
  const ctx = github.context;
  if (ctx.eventName !== 'issue_comment' && ctx.eventName !== 'pull_request_review_comment') return false;

  const comment = ctx.payload.comment as
    { body?: string; id?: number; in_reply_to_id?: number; user?: { login?: string } } | undefined;
  if (!comment?.body) return false;

  const secret = core.getInput('daemon-token') || envAny('TOKEN');
  const res = await fetch(`${url.replace(/\/$/, '')}/comment`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      pr: prNumber,
      token,
      body: comment.body,
      commentId: comment.id,
      // Only a review-comment event carries a thread to reply into.
      inReplyToId: ctx.eventName === 'pull_request_review_comment'
        ? (comment.in_reply_to_id ?? comment.id)
        : undefined,
      author: comment.user?.login ?? 'unknown',
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`daemon returned ${res.status}: ${text.slice(0, 400)}`);

  const out = JSON.parse(text) as {
    command: string; action: string;
    review?: { event: string; findings: number; titles: string[] };
  };
  core.info(`${out.command}: ${out.action}`);
  if (out.review) {
    for (const t of out.review.titles) core.info(`  ${t}`);
    core.setOutput('findings', String(out.review.findings));
    core.setOutput('event', out.review.event);
  }
  return true;
}

async function main() {
  const ctx = github.context;
  const identity = await resolveIdentity({
    appId: core.getInput('app-id'),
    privateKey: core.getInput('private-key'),
    token: core.getInput('github-token') || process.env.GITHUB_TOKEN,
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
  }, core.info);
  const token = identity.token;
  // Masked in the log even though nothing prints it. Registering costs nothing
  // and covers the case this cannot audit: a dependency, or a future line here,
  // putting the token into an error message.
  core.setSecret(token);

  // Our own comment, come back to us as an event. Only an App can reach this:
  // `GITHUB_TOKEN` activity never starts a workflow run, so the default path is
  // loop-immune by construction and the upgrade is what needs the guard.
  if (identity.login && ctx.payload.comment?.user?.login === identity.login) {
    core.info(`Ignoring an event caused by ${identity.login} itself`);
    return;
  }
  const prNumber =
    Number(core.getInput('pr-number')) ||
    ctx.payload.pull_request?.number ||
    ctx.payload.issue?.number;
  if (!prNumber) throw new Error('no pull request in context; pass pr-number');

  /**
   * A reply is answered, never re-reviewed.
   *
   * This is the failure that produced roughly five hundred comments on one pull
   * request. The workflow admits `pull_request_review_comment` events expecting
   * them to be answered; the deployed Action had no branch for them, so every
   * reply fell through to a full re-review. Ninety-nine replies became
   * sixty-three reviews.
   *
   * The bug was a missing branch, but the damage came from what the code did
   * without one: it fell through to the most expensive and least reversible
   * thing it knows how to do. So this returns rather than continuing, and the
   * check below refuses to run a review for a reply event at all — an event
   * this build cannot answer must end in nothing happening, not in a review.
   */
  const isReplyEvent = ctx.eventName === 'pull_request_review_comment';
  const replyTo = isReplyEvent
    ? (ctx.payload.comment as { in_reply_to_id?: number } | undefined)?.in_reply_to_id
    : undefined;

  if (isReplyEvent) {
    if (!replyTo) {
      core.info('A new review comment, not a reply to one. Nothing to answer.');
      return;
    }
    core.info('Answering a reply');
    const { runRespond } = await import('./respond.js');
    const out = await runRespond({
      token,
      selfLogin: identity.login,
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      prNumber,
      workspace: core.getInput('workspace') || process.env.GITHUB_WORKSPACE || process.cwd(),
      onlyThreadRootId: replyTo,
      log: core.info,
    });
    core.setOutput('answered', String(out.answered));
    core.setOutput('conceded', String(out.conceded));
    return;
  }

  const daemonUrl = core.getInput('daemon-url') || envAny('DAEMON_URL');
  if (daemonUrl) {
    core.info(`Delegating to the daemon at ${daemonUrl}`);
    // A comment is handled as a conversation turn; it may or may not review.
    if (await commentViaDaemon(daemonUrl, token, prNumber)) return;
    await viaDaemon(daemonUrl, token, prNumber);
    return;
  }
  core.info('No daemon-url set; running the pipeline in this job');
  await standalone(token, prNumber, identity.login);
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
