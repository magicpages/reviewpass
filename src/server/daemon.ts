import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runReview } from '../pipeline.js';
import { syncMirror, ensureCommit, createWorktree, mirrorPath } from '../git/mirror.js';
import { LearningStore } from '../store/learnings.js';
import { handleComment, isIgnored, type CommentEvent } from './comment.js';
import type { RunOutcome } from '../pipeline.js';

/**
 * The review daemon.
 *
 * It runs on the same host as the model and the self-hosted runners, which
 * changes what is possible compared with a self-contained Action:
 *
 *   - state persists, so learnings and finding history are a real database
 *     rather than something restored from a cache key;
 *   - repositories are kept as local mirrors, so a review fetches new refs
 *     instead of cloning, and gets full history for the context engine;
 *   - the model is on localhost, so large prompts cost nothing in transit.
 *
 * The Action becomes a thin client that posts a job here and prints the result.
 */

export interface DaemonOptions {
  port: number;
  host: string;
  dbPath: string;
  mirrorRoot: string;
  workRoot: string;
  /** Shared secret required in the Authorization header. */
  authToken?: string;
  concurrency: number;
}

export interface ReviewJob {
  owner: string;
  repo: string;
  pr: number;
  /** Installation or PAT token used for the GitHub API and for private fetches. */
  token: string;
  fullReview?: boolean;
  dryRun?: boolean;
  atSha?: string;
  profile?: 'assertive' | 'chill';
  model?: string;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Serialise work per pull request: two concurrent reviews would duplicate comments. */
class JobQueue {
  private active = new Map<string, Promise<unknown>>();
  private running = 0;
  private waiters: (() => void)[] = [];

  constructor(private limit: number) {}

  private async acquire(): Promise<void> {
    if (this.running < this.limit) { this.running++; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.running++;
  }

  private release(): void {
    this.running--;
    this.waiters.shift()?.();
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Coalesce: a second request for the same PR joins the in-flight review.
    const inflight = this.active.get(key);
    if (inflight) return inflight as Promise<T>;

    const task = (async () => {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
        this.active.delete(key);
      }
    })();
    this.active.set(key, task);
    return task;
  }

  get depth(): number {
    return this.active.size;
  }
}

export function createDaemon(opts: DaemonOptions) {
  const queue = new JobQueue(opts.concurrency);
  const started = new Date().toISOString();

  const authorised = (req: IncomingMessage): boolean => {
    if (!opts.authToken) return true;
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${opts.authToken}`;
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          const store = new LearningStore(opts.dbPath);
          const stats = store.stats();
          store.close();
          return json(res, 200, { ok: true, started, queued: queue.depth, ...stats });
        }

        if (req.method === 'POST' && req.url === '/comment') {
          if (!authorised(req)) return json(res, 401, { error: 'unauthorized' });
          const ev = JSON.parse(await readBody(req)) as CommentEvent;
          if (!ev.owner || !ev.repo || !ev.pr || !ev.token || ev.body === undefined) {
            return json(res, 400, { error: 'owner, repo, pr, token and body are required' });
          }

          const store = new LearningStore(opts.dbPath);
          let outcome;
          try {
            outcome = await handleComment(ev, store);
          } finally {
            store.close();
          }

          // A command that asks for a review runs it here, so the caller gets
          // one round trip rather than having to poll and re-post.
          if (outcome.triggersReview) {
            const key = `${ev.owner}/${ev.repo}#${ev.pr}`;
            const run = await queue.run(key, () => review({
              owner: ev.owner, repo: ev.repo, pr: ev.pr, token: ev.token,
              fullReview: outcome.fullReview,
            }, opts));
            return json(res, 200, { ...outcome, review: summarise(run) });
          }
          return json(res, 200, outcome);
        }

        if (req.method === 'POST' && req.url === '/review') {
          if (!authorised(req)) return json(res, 401, { error: 'unauthorized' });
          const job = JSON.parse(await readBody(req)) as ReviewJob;
          if (!job.owner || !job.repo || !job.pr || !job.token) {
            return json(res, 400, { error: 'owner, repo, pr and token are required' });
          }

          // Someone may have told reviewpass to leave this pull request alone.
          if (!job.atSha && await isIgnored(job.token, job.owner, job.repo, job.pr)) {
            return json(res, 200, { skipped: true, reason: 'review paused by @reviewpass ignore' });
          }

          const key = `${job.owner}/${job.repo}#${job.pr}`;
          const outcome = await queue.run(key, () => review(job, opts));
          return json(res, 200, summarise(outcome));
        }

        json(res, 404, { error: 'not found' });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  return {
    listen: () => new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function summarise(o: RunOutcome) {
  return {
    pr: o.pr.number,
    event: o.result.event,
    findings: o.result.findings.length,
    candidates: o.candidates,
    refuted: o.refuted.length,
    posted: o.posted,
    unanchored: o.plan.unanchored.length,
    resolved: o.resolved,
    effort: o.result.effort,
    mergeRisk: o.result.mergeRisk,
    usage: o.usage,
    titles: o.result.findings.map((f) => `${f.severity} ${f.path}:${f.startLine} ${f.title}`),
  };
}

/** One review: sync the mirror, materialise a worktree, run, clean up. */
async function review(job: ReviewJob, opts: DaemonOptions): Promise<RunOutcome> {
  const scope = `${job.owner}/${job.repo}`;
  const mirrorOpts = { root: opts.mirrorRoot, owner: job.owner, repo: job.repo, token: job.token };

  await syncMirror(mirrorOpts);
  const mirror = mirrorPath(mirrorOpts);

  // The head we need may have landed after the last fetch.
  const headSha = job.atSha ?? (await headOfPr(job, mirror));
  if (!(await ensureCommit(mirror, headSha, mirrorOpts))) {
    throw new Error(`commit ${headSha} is not reachable in the mirror`);
  }

  const tree = await createWorktree(mirror, headSha, opts.workRoot);
  const store = new LearningStore(opts.dbPath);
  const runId = store.startRun(scope, job.pr, headSha);
  const t0 = Date.now();

  try {
    const outcome = await runReview({
      token: job.token,
      owner: job.owner,
      repo: job.repo,
      prNumber: job.pr,
      workspace: tree.path,
      fullReview: job.fullReview,
      dryRun: job.dryRun,
      atSha: job.atSha,
      store,
      configOverrides: { name: job.model, profile: job.profile },
      log: {
        info: (m) => console.log(`[${scope}#${job.pr}] ${m}`),
        warn: (m) => console.warn(`[${scope}#${job.pr}] ${m}`),
      },
    });

    store.finishRun(runId, {
      files: outcome.pr.files.length,
      candidates: outcome.candidates,
      posted: outcome.posted,
      refuted: outcome.refuted.length,
      event: outcome.result.event,
      promptTokens: outcome.usage.promptTokens,
      completionTokens: outcome.usage.completionTokens,
      seconds: (Date.now() - t0) / 1000,
    });
    return outcome;
  } catch (err) {
    store.finishRun(runId, {
      files: 0, candidates: 0, posted: 0, refuted: 0, event: 'ERROR',
      promptTokens: 0, completionTokens: 0, seconds: (Date.now() - t0) / 1000,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    store.close();
    await tree.dispose();
  }
}

/** `refs/pull/N/head` from the mirror, so no API call is needed for the SHA. */
async function headOfPr(job: ReviewJob, mirror: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('git', ['rev-parse', `refs/pull/${job.pr}/head`], { cwd: mirror });
  return stdout.trim();
}
