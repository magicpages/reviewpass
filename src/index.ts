import { envAny } from './config/index.js';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { resolveIdentity, apiBaseUrl } from './github/auth.js';
import { parseDirective, helpText } from './github/commands.js';
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

async function standalone(token: string, prNumber: number, selfLogin?: string, forceFull = false): Promise<void> {
  const ctx = github.context;
  const profile = core.getInput('profile');
  // A crash must not leave the progress note saying a review is under way.
  // That note is the only thing on the pull request while the job runs, so a
  // stale one is a status that lies — the same failure as reporting "Nothing to
  // raise" for a review that never ran.
  const onCrash = async (err: unknown) => {
    try {
      const { GitHubClient } = await import('./github/client.js');
      const { renderProgressNotice } = await import('./review/render.js');
      const gh = new GitHubClient(token, ctx.repo.owner, ctx.repo.repo, selfLogin);
      const id = await gh.findWalkthroughId(prNumber);
      if (!id) return;
      await gh.upsertWalkthrough(prNumber, renderProgressNotice({ headSha: '' }, {
        kind: 'blocked',
        message: `The review did not finish: ${String(err).slice(0, 200)}`,
      }), id);
    } catch { /* the job already failed; do not fail it differently */ }
  };

  let outcome: Awaited<ReturnType<typeof runReview>>;
  try {
    outcome = await runReview({
      token,
      selfLogin,
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      prNumber,
      workspace: core.getInput('workspace') || process.env.GITHUB_WORKSPACE || process.cwd(),
      fullReview: forceFull || core.getInput('full-review') === 'true',
      configOverrides: {
        endpoint: core.getInput('model-endpoint') || undefined,
        name: core.getInput('model') || undefined,
        profile: profile === 'chill' || profile === 'assertive' ? profile : undefined,
      },
      log: { info: (m) => core.info(m), warn: (m) => core.warning(m) },
    });
  } catch (err) {
    await onCrash(err);
    throw err;
  }

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
   * A command, if the comment is addressed to us by name.
   *
   * Checked before the reply branch, which would otherwise swallow it: a thread
   * reply saying "@reviewpass full review" is an instruction, not a rebuttal to
   * argue with. The name comes from the identity we post under, so an
   * installation whose App is `acme-review` answers to `@acme-review` and to
   * nothing else.
   */
  const commentBody = (ctx.payload.comment as { body?: string } | undefined)?.body;
  const command = commentBody ? parseDirective(commentBody, identity.login) : null;

  if (command) {
    const say = async (text: string) => {
      const c = ctx.payload.comment as { id?: number; in_reply_to_id?: number } | undefined;
      const kit = github.getOctokit(token, { baseUrl: apiBaseUrl() });
      if (ctx.eventName === 'pull_request_review_comment' && c?.id) {
        await kit.rest.pulls.createReplyForReviewComment({
          owner: ctx.repo.owner, repo: ctx.repo.repo, pull_number: prNumber,
          comment_id: c.in_reply_to_id ?? c.id, body: text,
        });
      } else {
        await kit.rest.issues.createComment({
          owner: ctx.repo.owner, repo: ctx.repo.repo, issue_number: prNumber, body: text,
        });
      }
    };

    core.info(`Command: ${command.name}`);
    switch (command.name) {
      case 'help':
        await say(helpText(identity.login));
        return;
      case 'review':
      case 'full-review':
        await standalone(token, prNumber, identity.login, command.name === 'full-review');
        return;
      case 'resolve':
      case 'ignore':
      case 'resume':
        // Honest rather than silent: these need state that outlives a job.
        await say(
          `\`${command.name}\` needs the daemon, which this installation does not run. ` +
          `\`review\` and \`full review\` work here.`,
        );
        return;
      default:
        // `parseDirective` returns nothing else; a reply is handled below.
        break;
    }
  }

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

  /**
   * A review runs when something asked for one. Nothing else reaches here.
   *
   * The third time this shape has bitten: code that could not identify an event
   * carried on to the most expensive thing it knows how to do. A comment saying
   * "Ohh I saw that @reviewpass added a review earlier" mentions the bot, so the
   * workflow filter admits it; it is not a command and not a reply, and every
   * earlier version of this function would have answered it with a full review.
   *
   * The workflow's `contains()` filter cannot tell an instruction from someone
   * talking about the reviewer — GitHub expressions have no regular
   * expressions — so it is deliberately loose and this is where it is decided.
   * A job that starts and does nothing costs a runner minute. A review nobody
   * asked for costs a few hundred comments.
   */
  const askedForReview =
    ctx.eventName === 'pull_request' ||
    ctx.eventName === 'pull_request_target' ||
    ctx.eventName === 'workflow_dispatch' ||
    Boolean(core.getInput('pr-number'));
  if (!askedForReview) {
    core.info(`Nothing to do for a ${ctx.eventName} that is neither a command nor a reply.`);
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
