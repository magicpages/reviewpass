import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * The vocabulary here is the one teams already use for review tooling — path
 * filters, per-path instructions, severity thresholds — so a team can configure
 * this without learning a new set of words for familiar ideas.
 */
export interface ReviewpassConfig {
  model: {
    /** Primary endpoint. */
    endpoint: string;
    /**
     * Additional replicas to round-robin across. One dense model split over two
     * GPUs runs them in sequence and is *slower*; two independent replicas, one
     * per GPU, gave 41s -> 25s on four concurrent requests.
     */
    endpoints?: string[];
    name: string;
    /** A second model for the refutation pass. Falls back to `name`. */
    verifyModel?: string;
    /**
     * Extra routing sent verbatim with every request, for brokers that accept
     * it. Shape is the broker's, not ours: this does not interpret it.
     *
     * Reviewing sends proprietary source to whoever serves the request, so on a
     * broker this is where you constrain that — restricting to zero-retention
     * providers, pinning an order, excluding one you do not trust. Left unset,
     * nothing is sent and any OpenAI-compatible endpoint works unchanged.
     *
     * Ordering is worth setting deliberately: a broker left to route on price
     * can land on a provider serving the same model an order of magnitude
     * slower than the fast end of the pool.
     */
    provider?: Record<string, unknown>;
    temperature: number;
    maxTokens: number;
    /** Prompt budget per review unit, in tokens (roughly 4 chars each). */
    contextBudget: number;
    /**
     * Context sent per unit of diff, as a multiple of the patch length. The
     * reference reviewer states it holds roughly 1:1; it was measured at
     * 1:8.7 and, on a small diff, 1:26. Capping at 3 raised recall from 46/52
     * to 50/52 across the benchmark while sending a third of the characters -
     * most of what was being sent was diluting the change rather than
     * explaining it. 0 disables the cap.
     */
    contextRatio: number;
    requestTimeoutMs: number;
  };
  review: {
    profile: 'assertive' | 'chill';
    /** Findings at or above this severity block the PR. */
    requestChangesAt: 'critical' | 'major' | 'minor';
    approveWhenClean: boolean;
    maxFindings: number;
    incremental: boolean;
    /** Drop a finding unless the refutation pass fails to kill it. */
    verify: boolean;
    /** How many times to sample the find pass and union the results. */
    findSamples: number;
    /**
     * Findings rated at or below this by the verifier are dropped as trivia.
     * The verifier rates 1-10 and refuses only what is untrue; volume is
     * controlled here and by ranking, not by refutation - gating on importance
     * inside the verifier cost 63% of real defects when it was tried.
     */
    minImportance: number;
    postWalkthrough: boolean;
  };
  investigation: {
    enabled: boolean;
    maxTurns: number;
    maxOutputChars: number;
  };
  pathFilters: string[];
  pathInstructions: { path: string; instructions: string }[];
  tools: { eslint: boolean; tsc: boolean; custom: string[] };
  checks: {
    title: boolean;
    description: boolean;
    linkedIssues: boolean;
    outOfScope: boolean;
  };
  learnings: { enabled: boolean; dbPath: string };
}

const DEFAULTS: ReviewpassConfig = {
  model: {
    /*
     * Two measured configurations. This default is the hosted one, because it
     * is the one the numbers below were taken on; the local one is a two-line
     * change and is written out under "local" in README/.reviewpass.yaml.
     *
     *   find    deepseek-v4-flash   $0.081/$0.162 per 1M   86.5% recall over
     *                                                      32 cases / 52 findings
     *   verify  gpt-5.6-luna        $0.200/$1.200 per 1M   best measured filter
     *                                                      (F1 52 at 85% recall)
     *
     * Roughly $0.12 per pull request all in. Two models, not one, because they
     * are different jobs: on identical inputs deepseek-v4-flash kept 1 of 6 real
     * defects when asked to verify, and a stronger verifier kept 5 of 6. Finding
     * is cheap and wants recall; checking is expensive and wants judgement.
     *
     * Everything leaves the building, so REVIEWPASS_ZDR=1 is not optional in
     * production - it restricts routing to zero-data-retention providers and
     * orders them by measured throughput. Without it the broker routes on price
     * and lands on a provider serving this model at 5 tok/s.
     *
     * For a fully local review, set endpoint/endpoints to the llama.cpp router
     * and name to the served alias; leave verifyModel unset so one model does
     * both. That path has NOT been measured with the current prompts - the last
     * numbers for it predate the verifier rewrite and are void.
     */
    endpoint: 'https://openrouter.ai/api/v1',
    endpoints: ['https://openrouter.ai/api/v1'],
    name: 'deepseek/deepseek-v4-flash',
    verifyModel: 'openai/gpt-5.6-luna',
    temperature: 0.1,
    // A thinking model spends most of its budget before the first JSON byte;
    // 4k was not enough for a large file and produced empty completions.
    maxTokens: 16_384,
    // Shared across the changed files, then capped again per file by
    // contextRatio. The ceiling matters less than the ratio does.
    contextBudget: 120_000,
    contextRatio: 3,
    requestTimeoutMs: 900_000,
  },
  review: {
    profile: 'assertive',
    // Humans block rarely: across 5,842 human reviews in TryGhost/Ghost only
    // 2.7% requested changes, against 80% plain comments. Blocking on every
    // major finding would be far more obstructive than a colleague.
    requestChangesAt: 'critical',
    approveWhenClean: true,
    // A safety valve against a pathological diff, not a target. It was 30, and
    // on a real pull request it silently clipped 66 verified findings to 30 -
    // deciding on the author's behalf which two thirds they were allowed to see.
    // Volume is not the quality signal; truth and scope are.
    maxFindings: 100,
    incremental: true,
    verify: true,
    // Four passes: two general draws, then cross-file interactions, then what
    // the code does *not* do. The two general draws are what a plain sampled
    // find pass already did well (46/52); the focused passes add to them rather
    // than replace them, which matters - swapping the second general draw for a
    // focused one lost three real defects in a single file. The absence pass
    // earns its place on its own: it found the Mongo-operator defect that no
    // other configuration in this benchmark ever found.
    findSamples: 4,
    // 1-2 is trivia by the rubric: restates the code, pure style, an assertion
    // that would pass either way. Everything above it is ranked, not gated -
    // a PR with eight genuine problems should be able to report eight.
    minImportance: 0,
    postWalkthrough: true,
  },
  investigation: { enabled: true, maxTurns: 6, maxOutputChars: 200_000 },
  // Generated, vendored and binary files. Nothing here rewards reading: a lockfile
  // diff is machine output and a snapshot is a recording of a decision made elsewhere.
  pathFilters: [
    '!**/*.snap',
    '!**/*.lock',
    '!**/pnpm-lock.yaml',
    '!**/package-lock.json',
    '!**/yarn.lock',
    '!**/*.min.js',
    '!**/*.map',
    '!**/*.woff*',
    '!**/*.ttf',
    '!**/*.png',
    '!**/*.jpg',
    '!**/*.jpeg',
    '!**/*.gif',
    '!**/*.svg',
    '!**/*.ico',
    '!**/*.pdf',
    '!**/dist/**',
    '!**/build/**',
    '!**/node_modules/**',
    '!**/*.bru',
  ],
  pathInstructions: [],
  // The type checker was off by default AND could not have run anyway - a
  // worktree has no node_modules, so `npx --no-install tsc` failed and the error
  // was swallowed into an empty result indistinguishable from a clean run.
  // Both are fixed: dependencies are linked from the primary checkout, and tsc
  // runs per workspace package. It costs ~26s against a 20-40 minute review and
  // it settles a class of finding no amount of reasoning could - a claim of a
  // type error, an unresolved import or a signature mismatch is simply wrong
  // when the checker is green on that file.
  tools: { eslint: true, tsc: true, custom: [] },
  checks: { title: true, description: true, linkedIssues: true, outOfScope: true },
  learnings: { enabled: true, dbPath: '.reviewpass/learnings.json' },
};

/** Shallow-merge one level deep: enough for this shape, and predictable. */
function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)
      ? { ...(b as object), ...(v as object) }
      : v;
  }
  return out as T;
}

/**
 * An environment variable under either prefix.
 *
 * The tool was called something else until recently; deployments configured
 * then should not break on upgrade. New name wins where both are set.
 */
export const envAny = (suffix: string): string | undefined =>
  process.env[`REVIEWPASS_${suffix}`] ?? process.env[`WARREN_${suffix}`];

export function loadConfig(root: string): ReviewpassConfig {
  // New names first, old ones still read so a repository that configured this
  // before the rename keeps working without being touched.
  for (const name of [
    '.reviewpass.yaml', '.reviewpass.yml', '.github/reviewpass.yaml',
    '.warren.yaml', '.warren.yml', '.github/warren.yaml',
  ]) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    const raw = parse(readFileSync(p, 'utf8')) as Record<string, unknown> | null;
    const cfg = merge(DEFAULTS, raw);
    // Env always wins, so a workflow can point at a different box without a commit.
    return applyEnv(cfg);
  }
  return applyEnv({ ...DEFAULTS });
}

/** Environment overrides, applied last so a workflow can redirect without a commit. */
function applyEnv(cfg: ReviewpassConfig): ReviewpassConfig {
  const endpoint = envAny('ENDPOINT');
  const model = envAny('MODEL');
  const verifyModel = envAny('VERIFY_MODEL');
  if (endpoint) { cfg.model.endpoint = endpoint; cfg.model.endpoints = [endpoint]; }
  if (model) cfg.model.name = model;
  if (verifyModel) cfg.model.verifyModel = verifyModel;
  return cfg;
}

export { DEFAULTS };
