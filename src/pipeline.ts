import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, envAny, type ReviewpassConfig } from './config/index.js';
import { ModelClient } from './model/client.js';
import { blockerFor } from './model/blocked.js';
import { GitHubClient, type ReviewPlan } from './github/client.js';
import { selectFiles, groupFiles } from './context/select.js';
import { mineInstructions, rulesFor } from './context/instructions.js';
import { gatherContext, describeBackend, contextBudgetFor, filesNamedIn } from './context/retrieve.js';
import { buildIndex, listSourceFiles } from './graph/index.js';
import { runTools, toolFindingsFor , typeStrictness } from './context/tools.js';
import { scopesFor, type RecordedFinding } from './store/common.js';
import { FileLearningStore } from './store/file-learnings.js';
import { deriveMemory } from './store/derive.js';

import type { KnowledgeStore } from './store/knowledge.js';
import { rerankOverChange } from './store/rerank.js';
import { symbolsInPatch } from './context/retrieve.js';
import {
  findInFile, verify, rankAndCap, decideEvent, summarise, runChecks,
  collapseNearDuplicates, capPerRegion, citesMissingArtifact,
  groupByRegion, verifyGroup, reconcileWithRefutations } from './review/run.js';
import { renderWalkthrough, renderReviewSummary, renderProgressNotice } from './review/render.js';
import type { Finding, PullRequestContext, ReviewUnit, ReviewResult } from './types.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * What a review actually needs from a learnings store.
 *
 * Named because there are two backends — SQLite where it can run, a JSON file
 * on a hosted runner — and the pipeline should not care which it was handed.
 */
export interface LearningsBackend {
  recall(scopes: string[], path: string, limit?: number): string[];
  rejectedFingerprints(scopes: string[]): Set<string>;
  /** Record a finding a maintainer argued down. */
  reject(scope: string, fingerprint: string): void;
  seenOnPr(scope: string, pr: number): Set<string>;
  recordFinding(f: RecordedFinding): number;
  seedFromRules(scope: string, rules: { text: string; source: string; scope: string }[]): number;
  close(): void;
}

/**
 * How many model calls to have in flight.
 *
 * This has to match the server's slot count, and the deployment runs one slot.
 * Q5_K_XL leaves 0.9 GB free on a 32 GB card, so `parallel = 4` made the fitter
 * collapse each slot to 1024 tokens and overcommit the card. Concurrency beyond
 * the slot count only queues work past the client timeout, so raise this only
 * together with `parallel` on the server — and check `n_ctx_slot` afterwards.
 */

/**
 * How many files to review at once.
 *
 * This was 1, from when the endpoint was a local llama.cpp router with two
 * slots — where extra concurrency only queues, and can push the server into
 * swapping. Against a hosted endpoint that default is simply lost time: a
 * 22-file pull request took four minutes per file, in sequence, while the
 * benchmark had been running eight at a time against the same provider for
 * weeks.
 *
 * So it is chosen from the endpoint rather than fixed. A loopback or private
 * address means someone's own server and a small number of slots; anything else
 * is a service that expects concurrent callers. Override with
 * `REVIEWPASS_CONCURRENCY` when neither guess fits.
 */
function defaultConcurrency(endpoint: string): number {
  const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;
  return local.test(endpoint) ? 2 : 6;
}

/** Bounded concurrency for local work (file reads, search). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/** Anything that can supply changes and accept a review. */
export type ReviewSource = Pick<GitHubClient,
  'loadPullRequest' | 'loadExistingReview' | 'planComments' | 'currentHeadSha' |
  'submitReview' | 'upsertWalkthrough' | 'resolveThreads' | 'dismissStaleReviews'>
  & { raw?: unknown };

export interface RunOptions {
  /** Supply changes from somewhere other than a pull request. */
  source?: ReviewSource;
  token: string;
  /** The login the token posts as, e.g. `reviewpass[bot]`. */
  selfLogin?: string;
  owner: string;
  repo: string;
  prNumber: number;
  workspace: string;
  /** Review the whole PR rather than only the commits since the last run. */
  fullReview?: boolean;
  /** Compute everything but post nothing. */
  dryRun?: boolean;
  /** Review the PR as it stood at this commit. Implies dryRun. */
  atSha?: string;
  /**
   * Accumulated guidelines and learnings, keyed by repository. Supplied
   * separately from the per-PR store because it is expensive to build and is
   * shared across reviews.
   */
  knowledgePath?: string;
  /** Cross-encoder endpoint used to rank retrieved knowledge. Optional. */
  rerankEndpoint?: string;
  /**
   * An already-open store, supplied by the daemon so the database is opened once
   * per process rather than once per review.
   */
  store?: LearningsBackend;
  configOverrides?: Partial<ReviewpassConfig['model']> & { profile?: 'assertive' | 'chill' };
  log: Logger;
}

export interface RunOutcome {
  pr: PullRequestContext;
  result: ReviewResult;
  plan: ReviewPlan;
  walkthrough: string;
  summary: string;
  posted: number;
  resolved: number;
  usage: { promptTokens: number; completionTokens: number };
  candidates: number;
  refuted: Finding[];
}

/**
 * Learnings for one file: retrieve broadly, then let a cross-encoder rank them
 * against the change if one is configured. Retrieval reliably gets the right
 * rule into the pool; ranking it first is the hard part.
 */
async function recallLearnings(
  knowledge: KnowledgeStore | null,
  store: LearningsBackend | null,
  scopes: string[],
  file: { path: string; patch?: string },
  opts: RunOptions,
  log: Logger,
): Promise<string[]> {
  const own = store?.recall(scopes, file.path, 8) ?? [];
  if (!knowledge) return own;

  const patch = file.patch ?? '';
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const candidates = knowledge.retrieve(scopes, {
    path: file.path, symbols: symbolsInPatch(patch), imports: [], text: added,
  }, 60);

  let ranked = candidates;
  if (opts.rerankEndpoint && candidates.length > 1) {
    ranked = await rerankOverChange(file.path, added, candidates, {
      endpoint: opts.rerankEndpoint,
      topN: 60,
      onError: (m) => log.warn(m),
    });
  }
  return [...own, ...ranked.slice(0, 10).map((r) => r.content)];
}

/**
 * The learnings store, on whatever this host can actually run.
 *
 * SQLite is preferred where it works — it is faster and the daemon's full-text
 * and vector search depend on it. It does not work on a stock GitHub runner:
 * `better-sqlite3` binds a compiled `better_sqlite3.node` that no bundler can
 * inline, so the whole review used to die opening a store that holds a few
 * hundred short strings. A JSON file covers the same six operations with no
 * native dependency.
 *
 * A `.json` path picks the file store outright; otherwise SQLite is tried and
 * the file store catches it. Failing to open either is not fatal: memory of
 * *other* pull requests is an optimisation, and this one is reviewable without it.
 */
export async function openLearningStore(
  path: string,
  log: { info(m: string): void; warn(m: string): void },
): Promise<LearningsBackend | null> {
  if (/\.json$/i.test(path)) return new FileLearningStore(path);
  try {
    // Imported here rather than at the top of the module: a static import puts
    // `better-sqlite3` in the bundle's import graph, and an ESM bundle resolves
    // those before running anything — so a command that never opens a SQLite
    // store still failed on a machine that has no compiled binding for one.
    const { LearningStore } = await import('./store/learnings.js');
    return new LearningStore(path);
  } catch (err) {
    const jsonPath = path.replace(/\.[^.]+$/, '.json');
    log.info(`native store unavailable (${String(err).slice(0, 80)}); using ${jsonPath}`);
    try {
      return new FileLearningStore(jsonPath);
    } catch {
      log.warn('no learnings store available; reviewing without cross-PR memory');
      return null;
    }
  }
}

export async function runReview(opts: RunOptions): Promise<RunOutcome> {
  const { log, owner, repo, prNumber, workspace } = opts;
  const cfg = loadConfig(workspace);
  if (opts.configOverrides) {
    const { profile, ...model } = opts.configOverrides;
    Object.assign(cfg.model, Object.fromEntries(Object.entries(model).filter(([, v]) => v !== undefined)));
    if (profile) cfg.review.profile = profile;
  }

  // The source varies (a pull request, a local git range); the review does not.
  const gh = opts.source ?? new GitHubClient(opts.token, owner, repo, opts.selfLogin);
  const model = new ModelClient(cfg);

  const pr = await gh.loadPullRequest(
    prNumber, cfg.review.incremental && !opts.fullReview, opts.atSha,
  );
  /**
   * The workspace has to be the code being reviewed.
   *
   * `runRespond` refuses outright on a mismatch; a review only warns, because a
   * local run against uncommitted work is a legitimate use and the diff itself
   * always comes from the pull request. What comes from the workspace is the
   * surrounding context — the whole file, its neighbours, the symbol graph — so
   * a stale checkout produces findings reasoned from code the author did not
   * write, which read as confident and are wrong.
   *
   * Caught by the reviewer itself on a workflow of mine: an `issue_comment`
   * carries no `pull_request` object, `github.ref` falls back to the default
   * branch, and the job would have reviewed `main` while reporting against the
   * pull request.
   */
  if (pr.headSha && !opts.atSha) {
    try {
      const head = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (head !== pr.headSha) {
        log.warn(
          `Workspace is at ${head.slice(0, 8)} but the pull request head is ` +
          `${pr.headSha.slice(0, 8)}. Context will be read from the wrong code.`,
        );
      }
    } catch { /* not a git checkout; nothing to compare against */ }
  }

  const prior = await gh.loadExistingReview(prNumber);

  log.info(
    `Reviewing ${owner}/${repo}#${prNumber} — ${pr.files.length} changed files` +
    (pr.isIncremental ? ` (incremental from ${pr.reviewedFrom.slice(0, 7)})` : ''),
  );

  // ── select ────────────────────────────────────────────────────────────────
  const { selected, skipped } = selectFiles(pr.files, cfg.pathFilters);
  log.info(`Selected ${selected.length} files, skipped ${skipped.length}`);

  /**
   * Say that a review has started, before spending ten minutes on it.
   *
   * Without this the only thing separating "thinking" from "broken" is whether
   * somebody thinks to open the Actions tab. It claims the walkthrough comment,
   * so the finished review overwrites it rather than adding a second one.
   *
   * Best-effort throughout: failing to announce a review is not a reason to
   * skip it.
   */
  if (!opts.dryRun && cfg.review.postWalkthrough) {
    try {
      await gh.upsertWalkthrough(
        prNumber,
        renderProgressNotice(pr, selected.length
          ? { kind: 'started', files: selected.length, incremental: pr.isIncremental === true }
          : { kind: 'nothing', reason: 'nothing in this update is a file it reviews.' }),
        prior.walkthroughCommentId,
      );
    } catch (err) {
      log.warn(`could not post the progress note: ${String(err).slice(0, 120)}`);
    }
  }

  if (!selected.length) {
    const empty: ReviewResult = {
      findings: [], walkthrough: 'No reviewable changes in this update.', fileGroups: [],
      effort: { score: 1, label: 'Trivial' }, mergeRisk: 'minimal', checks: [],
      event: decideEvent([], cfg, false, prior.openFindings), skipped,
    };
    const plan: ReviewPlan = { anchored: [], unanchored: [] };
    if (!opts.dryRun) {
      if (empty.event !== 'REQUEST_CHANGES') {
        await gh.dismissStaleReviews(
          prNumber, 'Superseded: no reviewable changes remain in this update.');
      }
      await gh.submitReview(prNumber, pr.headSha, plan, empty.walkthrough, empty.event);
    }
    return {
      pr, result: empty, plan, walkthrough: renderWalkthrough(pr, empty),
      summary: empty.walkthrough, posted: 0, resolved: 0, usage: model.usage,
      candidates: 0, refuted: [],
    };
  }

  // ── context ───────────────────────────────────────────────────────────────
  const concurrency = Number(envAny('CONCURRENCY') ?? defaultConcurrency(cfg.model.endpoint));
  if (concurrency > 1) log.info(`Reviewing ${concurrency} files at a time`);

  const rules = mineInstructions(
    workspace,
    selected.map((f) => f.path),
    new Map(selected.map((f) => [f.path, f.patch ?? ''])),
  );
  log.info(`Mined ${rules.length} rules from instruction files`);

  const ownsStore = !opts.store;
  const store = opts.store ?? (cfg.learnings.enabled ? await openLearningStore(cfg.learnings.dbPath, log) : null);
  if (store) {
    const seeded = store.seedFromRules(`${owner}/${repo}`, rules);
    if (seeded) log.info(`Seeded ${seeded} learnings from repository rules`);
  }
  const scopes = scopesFor(owner, repo);
  const scope = `${owner}/${repo}`;
  // Cross-pull-request memory, read back from the pull requests themselves.
  // Costs about a second and a handful of API points, and needs no storage —
  // see store/derive.ts for why every place to keep a second copy is worse.
  const recalled = gh.raw
    ? await deriveMemory(gh.raw as Parameters<typeof deriveMemory>[0], owner, repo, { log: (m) => log.info(m) })
    : { rejected: new Set<string>(), learnings: [] as { content: string; sourcePr: number; path?: string }[] };
  const rejected = new Set<string>([
    ...(store?.rejectedFingerprints(scopes) ?? []),
    ...recalled.rejected,
  ]);
  // The daemon remembers what it posted, so a re-run does not repeat itself
  // even when GitHub's comment list is unavailable.
  const alreadyPosted = store?.seenOnPr(scope, prNumber) ?? new Set<string>();

  const toolFindings = await runTools(workspace, selected.map((f) => f.path), cfg, (m) => log.info(m)).catch((e) => {
    log.warn(`static analysis failed: ${e}`);
    // null, not [] - a crash must not be reported to the verifier as a clean run.
    return null;
  });
  const toolsRan = toolFindings !== null;
  if (!toolsRan) log.warn('static analysis did not run — findings will not be checked against it');
  else if (toolFindings.length) log.info(`Static analysis reported ${toolFindings.length} issues`);
  else log.info('Static analysis ran clean');

  // Guidelines and learnings accumulated from earlier reviews. Two of the five
  // defects in the benchmark were ones the reference reviewer attributed to
  // exactly this — "_Source: Learnings_" and "_Source: Coding guidelines_".
  // Same reason as the learnings store: only load the native-backed knowledge
  // index when a path for one was actually given.
  const knowledge = opts.knowledgePath
    ? new (await import('./store/knowledge.js')).KnowledgeStore(opts.knowledgePath)
    : null;
  if (knowledge) log.info(`Knowledge store: ${JSON.stringify(knowledge.stats())}`);

  // One parse of the repository, reused for every file in the review. About two
  // seconds for a 1,900-file monorepo, which is negligible beside a single model
  // call and replaces guesswork about who calls what.
  const graph = await buildIndex(workspace, (m) => log.info(m)).catch((e) => {
    log.warn(`code graph unavailable: ${e}`);
    return undefined;
  });

  const perFileBudget = Math.floor((cfg.model.contextBudget * 4) / Math.max(1, selected.length));
  const units: ReviewUnit[] = await mapLimit(selected, 4, async (file) => {
    // Two ceilings, and the smaller wins. `contextBudget` shares the prompt out
    // across the changed files; `contextRatio` keeps the context proportional to
    // the change, because a 600-character diff does not become clearer for being
    // wrapped in 16k characters of its neighbours - measured, it becomes less
    // clear, and four benchmark findings were lost that way.
    // Read the file before retrieving, so import-following and the budget
    // calculation below can both see every module the file depends on.
    let fileText: string | undefined;
    try {
      const raw = await readFile(join(workspace, file.path), 'utf8');
      if (raw.length <= 60_000) fileText = raw;
    } catch { /* deleted or binary */ }

    const ceiling = Math.max(8_000, Math.min(32_000, perFileBudget));
    const budgetChars = contextBudgetFor({
      patch: file.patch ?? '', fileText, contextRatio: cfg.model.contextRatio, ceiling,
    });

    const retrieved = await gatherContext({
      root: workspace, path: file.path, patch: file.patch ?? '', budgetChars, graph, fileText,
    }).catch(() => []);
    // `fileText` is also what lets the verifier settle factual claims - "this
    // import is unused", "this is never reset" - which a window cannot: shown
    // only a window it upheld "remove the unused `Link` import" at confidence
    // 1.0 with the four uses just off-screen.
    return {
      path: file.path,
      file,
      fileText,
      context: retrieved.map((r) => `## ${r.label}\n\n\`\`\`\n${r.text}\n\`\`\``).join('\n\n'),
      instructions: [
        ...rulesFor(rules, file.path, cfg.pathInstructions),
        // Guidelines are matched by glob, not similarity: a rule applies because
        // of where the file sits and what the change does, which is a trigger,
        // not a topic.
        ...(knowledge?.guidelinesFor(scopes, file.path, 12).map((g) => g.content) ?? []),
      ],
      learnings: [
        ...await recallLearnings(knowledge, store, scopes, file, opts, log),
        // A correction a maintainer wrote on this same file elsewhere is the
        // most directly relevant thing we can show the reviewer.
        ...recalled.learnings
          .filter((l) => !l.path || l.path === file.path)
          .slice(0, 5)
          .map((l) => `From review of #${l.sourcePr}: ${l.content}`),
      ],
      toolFindings: toolFindingsFor(toolFindings ?? [], file.path),
      toolsRan,
      strictness: typeStrictness(workspace, file.path),
    };
  });
  log.info(`Search backend: ${await describeBackend(workspace)}`);
  log.info(`Assembled context for ${units.length} files ` +
    `(${units.reduce((n, u) => n + u.context.length, 0).toLocaleString()} chars)`);

  // ── find ──────────────────────────────────────────────────────────────────
  let failures = 0;
  const failureErrors: unknown[] = [];
  const found = (await mapLimit(units, concurrency, async (unit) => {
    try {
      const fs = await findInFile(model, cfg, pr, unit);
      log.info(`  ${unit.path}: ${fs.length} candidate(s)`);
      return fs;
    } catch (err) {
      failures++;
      failureErrors.push(err);
      log.warn(`review failed for ${unit.path}: ${err}`);
      return [] as Finding[];
    }
  })).flat();
  log.info(`Raised ${found.length} candidate findings`);

  const fresh = found.filter((f) => {
    const fp = f.fingerprint!;
    if (rejected.has(fp)) { log.info(`suppressed previously rejected: ${f.title}`); return false; }
    return !prior.fingerprints.has(fp) && !alreadyPosted.has(fp);
  });

  // ── verify ────────────────────────────────────────────────────────────────
  // Collapse duplicates BEFORE verifying, not after. Sampling the find pass
  // twice phrases one defect two ways, and verifying both buys the same answer
  // twice - which is free with a cheap model and is not with the one that
  // actually verifies well. Measured, it removed ~40% of the calls with no
  // recall cost.
  const deduped = capPerRegion(collapseNearDuplicates(fresh), 3);
  if (deduped.length < fresh.length) {
    log.info(`Collapsed ${fresh.length} candidates to ${deduped.length} before verification`);
  }

  // Drop what names something the repository does not contain, before paying a
  // model to think about it. A finding that cited a module which never existed
  // reached a live pull request and read as authoritative all the way through.
  const repoFiles = new Set(listSourceFiles(workspace));
  const unitByPathEarly = new Map(units.map((u) => [u.path, u]));
  const grounded = deduped.filter((f) => {
    const missing = citesMissingArtifact(f, repoFiles);
    if (missing) {
      log.info(`dropped (cites missing \`${missing}\`): ${f.title}`);
      return false;
    }
    return true;
  });

  let kept = grounded;
  const refuted: Finding[] = [];
  if (cfg.review.verify && grounded.length) {
    const unitByPath = new Map(units.map((u) => [u.path, u]));
    // One call per region rather than per finding: fewer calls, and the only
    // arrangement where two findings about the same code cannot be given
    // opposite verdicts.
    const regions = groupByRegion(grounded);
    const multi = regions.filter((g) => g.length > 1).length;
    if (multi) log.info(`Verifying ${regions.length} regions (${multi} with several findings)`);
    const verified = (await mapLimit(regions, concurrency,
      (g) => verifyGroup(model, cfg, g, unitByPath.get(g[0]!.path)!, pr, {
        filesNamedIn: (f) => filesNamedIn(f, workspace, f.path, graph),
      }))).flat();
    for (const f of verified) if (f.verdict === 'refuted') refuted.push(f);
    // Refuted means untrue. Rated trivia is a separate matter and is dropped
    // here rather than by the verifier, because gating on importance cost 63%
    // of the defects this team really fixed when it was tried.
    kept = verified.filter((f) => f.verdict !== 'refuted' && (f.importance ?? 5) > cfg.review.minImportance);

    // A claim disproved in one region is disproved everywhere. Verification
    // judges each region against its own evidence, so the same claim raised
    // against three files is decided three times and only the group holding
    // the call site sees what settles it.
    const reconciled = reconcileWithRefutations(kept, refuted, (m) => log.info(m));
    if (reconciled.overturned.length) {
      log.info(`Dropped ${reconciled.overturned.length} finding(s) disproved elsewhere in this review`);
      refuted.push(...reconciled.overturned);
      kept = reconciled.kept;
    }
    log.info(`Verification kept ${kept.length} of ${grounded.length}`);
  }

  const findings = rankAndCap(kept, cfg.review.maxFindings);

  // ── summarise ─────────────────────────────────────────────────────────────
  const [walk, checks] = await Promise.all([
    summarise(model, cfg, pr).catch((e) => {
      log.warn(`walkthrough failed: ${e}`);
      return {
        summary: 'Summary unavailable.',
        groups: [...groupFiles(selected)].map(([label, files]) => ({
          label, summary: `${files.length} file(s) changed`, files: files.map((f) => f.path),
        })),
        effort: { score: 3, label: 'Moderate' },
        mergeRisk: 'moderate' as const,
        mergeRiskReason: '',
      };
    }),
    runChecks(model, cfg, pr),
  ]);

  const event = decideEvent(findings, cfg, failures > 0, prior.openFindings);
  const reviewedFiles = units.length - failures;
  // Every file hit the same wall, and it is a wall the author of this pull
  // request cannot climb. Say so plainly instead of reporting a clean review.
  const blocked = blockerFor(failureErrors, units.length) ?? undefined;
  const result: ReviewResult = {
    findings, walkthrough: walk.summary, fileGroups: walk.groups,
    effort: walk.effort, mergeRisk: walk.mergeRisk, checks, event, skipped,
    reviewedFiles, failedFiles: failures, blocked, openFindings: prior.openFindings,
  };

  // ── post ──────────────────────────────────────────────────────────────────
  // Anchor first: the summary has to report whatever could not be posted inline.
  const diffLines = new Map(selected.map((f) => [f.path, new Set(f.addedLines)]));
  const plan = gh.planComments(findings, diffLines);
  const summary = renderReviewSummary(result, plan.unanchored);
  const walkthrough = renderWalkthrough(pr, result);

  let posted = 0;
  let resolved = 0;
  if (!opts.dryRun) {
    // The head may have moved while we were reviewing. Comments anchored to a
    // superseded commit get collapsed as outdated, so the author never sees
    // them. We cannot re-anchor safely - the code they describe may have
    // changed - but we can make sure nothing is invisible: say so at the top,
    // and repeat every finding in the review body where it cannot be hidden.
    const headNow = await gh.currentHeadSha(prNumber);
    const stale = headNow !== null && headNow !== pr.headSha;
    if (stale) {
      log.warn(`head moved during review (${pr.headSha.slice(0, 8)} -> ${headNow!.slice(0, 8)}); ` +
        'inline comments may show as outdated, so findings are repeated in the summary');
    }
    const body = stale
      ? `> Reviewed at \`${pr.headSha.slice(0, 8)}\`; the branch has since moved to ` +
        `\`${headNow!.slice(0, 8)}\`. Some inline comments may appear as outdated, so every ` +
        `finding is listed below as well.\n\n${summary}\n\n` +
        `<details>\n<summary>All ${findings.length} findings</summary>\n\n` +
        findings.map((f) => `**\`${f.path}\`:${f.startLine}** — ${f.title}\n\n${f.body}`).join('\n\n---\n\n') +
        '\n\n</details>'
      : summary;
    // Whatever this review concludes, an earlier blocking verdict that no longer
    // reflects the code must not survive it.
    if (event !== 'REQUEST_CHANGES') {
      const cleared = await gh.dismissStaleReviews(
        prNumber, 'Superseded: the findings that blocked this review are no longer present.');
      if (cleared) log.info(`Dismissed ${cleared} stale request-changes review(s)`);
    }
    ({ posted } = await gh.submitReview(prNumber, pr.headSha, plan, body, event));
    if (cfg.review.postWalkthrough) {
      // A blocked run has no walkthrough worth posting — the model never ran —
      // so the note says why instead of being replaced by an empty summary.
      await gh.upsertWalkthrough(
        prNumber,
        blocked ? renderProgressNotice(pr, { kind: 'blocked', message: blocked.message }) : walkthrough,
        prior.walkthroughCommentId,
      );
    }
    const stillOpen = new Set(findings.map((f) => f.fingerprint!));
    const gone = new Set([...prior.fingerprints].filter((fp) => !stillOpen.has(fp)));
    resolved = await gh.resolveThreads(prNumber, gone).catch(() => 0);
  }

  for (const f of [...findings, ...refuted]) {
    store?.recordFinding({
      scope, pr: prNumber, headSha: pr.headSha, fingerprint: f.fingerprint!,
      path: f.path, startLine: f.startLine, endLine: f.endLine,
      severity: f.severity, category: f.category, title: f.title, body: f.body,
      hadSuggestion: Boolean(f.suggestion), verdict: f.verdict,
      posted: !opts.dryRun && findings.includes(f),
    });
  }
  if (ownsStore) store?.close();
  knowledge?.close();

  return {
    pr, result, plan, walkthrough, summary, posted, resolved,
    usage: model.usage, candidates: found.length, refuted,
  };
}
