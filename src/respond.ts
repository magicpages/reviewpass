import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config/index.js';
import { ModelClient } from './model/client.js';
import { GitHubClient, type Rebuttal } from './github/client.js';
import { buildIndex } from './graph/index.js';
import { filesNamedIn } from './context/retrieve.js';
import {
  RESPONDER_SYSTEM, RESPONSE_SCHEMA, buildRespondPrompt, settleResponse,
} from './review/respond.js';

/**
 * Answer the maintainers who answered us.
 *
 * Deliberately not part of `runReview`. A push and a reply are different events
 * needing different work: one re-reads the code, the other re-reads an
 * argument. Folding them together meant a reply either triggered a whole
 * re-review - minutes of model time to produce nothing about the thing that was
 * actually said - or was mined silently for learnings and never answered.
 */

export interface RespondOptions {
  token: string;
  selfLogin?: string;
  owner: string;
  repo: string;
  prNumber: number;
  workspace: string;
  /** Answer only this thread, when a single reply triggered the run. */
  onlyThreadRootId?: number;
  dryRun?: boolean;
  log?: (m: string) => void;
}

export interface RespondOutcome {
  answered: number;
  conceded: number;
  held: number;
  threads: { path: string; concede: boolean; reply: string }[];
}

export async function runRespond(opts: RespondOptions): Promise<RespondOutcome> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const cfg = loadConfig(opts.workspace);
  const model = new ModelClient(cfg);
  const gh = new GitHubClient(opts.token, opts.owner, opts.repo, opts.selfLogin);

  let open = await gh.openRebuttals(opts.prNumber);
  if (opts.onlyThreadRootId) {
    open = open.filter((r) => r.rootCommentId === opts.onlyThreadRootId);
  }
  if (!open.length) {
    log('No unanswered replies.');
    return { answered: 0, conceded: 0, held: 0, threads: [] };
  }
  log(`${open.length} unanswered ${open.length === 1 ? 'reply' : 'replies'}`);

  const pr = await gh.loadPullRequest(opts.prNumber, false).catch(() => undefined);

  // The workspace has to be the code they are arguing about.
  //
  // Caught in testing, and it produced the most convincing possible wrong
  // answer: a worktree sat one commit behind, the reviewer read a stale-read
  // guard the maintainer had already replaced with an atomic one, and held its
  // ground citing a real line of a file that no longer looked like that. It
  // reasoned correctly from stale evidence, which is indistinguishable from
  // reasoning badly right up until someone checks. On the current head it
  // conceded immediately.
  //
  // Refusing to post is the point. A wrong concession is recorded as a
  // rejection and suppresses a real finding forever; a wrong hold argues with
  // somebody who is right, in public, under the team's own bot name.
  if (pr?.headSha) {
    let head: string | undefined;
    try {
      head = execFileSync('git', ['-C', opts.workspace, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { /* not a git checkout; nothing to compare */ }

    if (head && head !== pr.headSha) {
      const detail = `workspace is at ${head.slice(0, 8)}, pull request head is ${pr.headSha.slice(0, 8)}`;
      if (opts.dryRun) {
        log(`Warning: ${detail}. Answers will be judged against the wrong code.`);
      } else {
        throw new Error(
          `Refusing to reply: ${detail}. Check the workspace out at the pull request head first.`,
        );
      }
    }
  }
  // Built once for the whole run: the reply usually names the file that settles
  // the question, and resolving that name is what this pass turns on.
  const graph = await buildIndex(opts.workspace).catch(() => undefined);

  const out: RespondOutcome = { answered: 0, conceded: 0, held: 0, threads: [] };

  for (const r of open) {
    try {
      const fileText = await readFile(join(opts.workspace, r.path), 'utf8').catch(() => undefined);
      const named = await filesNamedIn(
        { title: '', body: r.replies.map((c) => c.body).join('\n') },
        opts.workspace, r.path, graph,
      ).catch(() => []);

      const { value } = await model.json<{
        concede: boolean; reply: string; confidence?: number; contradicting_line?: string;
      }>(
        [
          { role: 'system', content: RESPONDER_SYSTEM },
          {
            role: 'user',
            content: buildRespondPrompt(r, fileText, named, pr && { title: pr.title, body: pr.body }),
          },
        ],
        RESPONSE_SCHEMA,
        { schemaName: 'response', model: cfg.model.verifyModel ?? cfg.model.name, maxTokens: 1536 },
      );

      const decision = settleResponse(value, fileText, log);
      log(`  ${decision.concede ? 'concede' : 'hold   '}  ${r.path}: ${decision.reply.slice(0, 90)}`);
      out.threads.push({ path: r.path, concede: decision.concede, reply: decision.reply });
      decision.concede ? out.conceded++ : out.held++;
      out.answered++;

      if (opts.dryRun) continue;

      await gh.replyInThread(opts.prNumber, r.rootCommentId, decision.reply);
      if (decision.concede) {
        // Resolving and recording are the point of conceding. An unresolved
        // thread still reads as an open objection, and an unrecorded rejection
        // comes back as the same finding on the next pull request.
        await gh.resolveThreadById(r.threadId).catch((err) =>
          log(`  could not resolve the thread: ${String(err).slice(0, 120)}`));
        await recordRejection(opts, r);
      }
    } catch (err) {
      // One thread failing must not cost the others. A reply that cannot be
      // written is a thread left open, which is where it started.
      log(`  could not answer ${r.path}: ${String(err).slice(0, 160)}`);
    }
  }

  log(`Answered ${out.answered}: conceded ${out.conceded}, held ${out.held}`);
  return out;
}

/**
 * Remember that this finding was argued down.
 *
 * Best-effort by design. The durable copy of this decision is the reply itself,
 * sitting in the thread, which `deriveMemory` reads back from GitHub on any
 * later run - so a store that is absent or read-only costs nothing that cannot
 * be reconstructed.
 */
async function recordRejection(opts: RespondOptions, r: Rebuttal): Promise<void> {
  try {
    const { openLearningStore } = await import('./pipeline.js');
    const cfg = loadConfig(opts.workspace);
    if (!cfg.learnings.enabled) return;
    const quiet = { info: () => {}, warn: () => {} };
    const store = await openLearningStore(cfg.learnings.dbPath, quiet);
    if (!store) return;
    store.reject(`${opts.owner}/${opts.repo}`, r.fingerprint);
    store.close();
  } catch {
    // No store, or no write access. The thread is the record.
  }
}
