/**
 * Run one method on one case: reviewpass's real pipeline, or a raw model given
 * nothing but the task. Both return findings in the same shape so the reference
 * and the scoring never need to know which produced them.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runReview } from '../src/pipeline.js';
import { LocalSource } from '../src/local/source.js';
import { FileLearningStore } from '../src/store/file-learnings.js';
import { ModelClient } from '../src/model/client.js';
import { loadConfig, type ReviewpassConfig } from '../src/config/index.js';
import type { Finding, PullRequestContext } from '../src/types.js';
import type { BenchFinding, Case, FindingMeta, Run } from './types.js';

export type Effort = NonNullable<ReviewpassConfig['model']['reasoningEffort']>;

/** The model a method runs on. Same settings for find and verify, as in production. */
export interface ModelSetting {
  endpoint: string;
  name: string;
  effort?: Effort;
  /** Initial find budget; reviewpass escalates it on a length failure. */
  maxTokens: number;
  /** A different model for verification; the find model verifies when unset. */
  verifyName?: string;
  /** The verify pass's own `reasoning_effort`; `effort` applies when unset. */
  verifyEffort?: Effort;
  /** Tells apart two runs of otherwise identical settings, e.g. before and after a change. */
  label?: string;
}

/** A method key as it appears in run file names. */
export const runFileStem = (key: string) => key.replace(/[^A-Za-z0-9@._-]/g, '_');

/**
 * Method keys that would share run files. The file name folds every character it
 * cannot hold into `_`, so `label: "a/b"` and `label: "a:b"` would read each
 * other's runs. Refused before anything runs rather than changing the encoding,
 * which would orphan every run already written.
 */
export function collidingKeys(keys: string[]): string[][] {
  const byStem = new Map<string, Set<string>>();
  for (const k of keys) byStem.set(runFileStem(k), (byStem.get(runFileStem(k)) ?? new Set()).add(k));
  return [...byStem.values()].filter((s) => s.size > 1).map((s) => [...s]);
}

/** Unchanged for settings without the newer fields, so earlier runs are still found. */
export const methodKey = (kind: 'reviewpass' | 'raw', m: ModelSetting) =>
  `${kind}@${m.name}@${m.effort ?? 'default'}@${m.maxTokens}`
  + (m.verifyName ? `+verify=${m.verifyName}` : '') + (m.verifyEffort ? `@${m.verifyEffort}` : '')
  + (m.label ? `#${m.label}` : '');

/**
 * A local range carries no statement of intent: LocalSource falls back to the
 * branch name. In production the model reads the pull request's title and body,
 * the strongest account of what the change was meant to do, so the case supplies
 * them here.
 */
class CaseSource extends LocalSource {
  constructor(private c: Case) { super(c.workspace, c.base, c.head); }

  override async loadPullRequest(n: number, incremental: boolean, atSha?: string): Promise<PullRequestContext> {
    const pr = await super.loadPullRequest(n, incremental, atSha);
    return { ...pr, title: this.c.title, body: this.c.body };
  }
}

/**
 * What the method recorded about a finding, or nothing when it recorded nothing.
 * A raw finding has none of these fields; an empty `meta` would still mark it as
 * one the filters can read, and every filter on support would then drop it.
 */
export function findingMeta(f: Partial<Finding>): FindingMeta | undefined {
  const meta: FindingMeta = {};
  if (f.severity !== undefined) meta.severity = f.severity;
  if (f.category !== undefined) meta.category = f.category;
  if (f.importance !== undefined) meta.importance = f.importance;
  if (f.confidence !== undefined) meta.confidence = f.confidence;
  if (f.verdictReason !== undefined) meta.verdictReason = f.verdictReason;
  if (f.samples !== undefined) meta.samples = f.samples;
  return Object.keys(meta).length ? meta : undefined;
}

const bench = (caseId: string, method: string, run: number) =>
  (f: { path: string; startLine: number; endLine: number; title: string; body: string } & Partial<Finding>, i: number): BenchFinding => {
    const meta = findingMeta(f);
    return {
      id: `${caseId}/${method}/${run}/${i}`, path: f.path, startLine: f.startLine, endLine: f.endLine, title: f.title, body: f.body,
      ...(meta ? { meta } : {}),
    };
  };

/**
 * reviewpass as it runs in CI, against a frozen checkout.
 *
 * Two things are isolated per run, because the method depends on runs being
 * independent. The learnings store is fresh and outside the checkout: a review
 * records every finding into it even on a dry run, so a shared one would let run
 * two recall run one. And verify failures are counted, because verify fails open
 * - a verdict that never arrived keeps the finding, and a verifier that silently
 * errored on every call would score as one that approved everything.
 */
/**
 * Whether a file's failure was the endpoint's rather than the model's. A file lost
 * to a rate limit says nothing about the method and the run must be redone; a file
 * lost to a malformed reply is what the method does, and the run stands.
 */
export const endpointFailure = (message: string) =>
  /unreachable after retries|rate limit|model (40[1-3]|429)\b|upstream 5\d\d\b|fetch failed|ECONN|timed? ?out/i.test(message);

export async function runReviewpass(c: Case, m: ModelSetting, run: number): Promise<Run> {
  const method = methodKey('reviewpass', m);
  const scratch = mkdtempSync(join(tmpdir(), 'reviewpass-bench-'));
  const store = new FileLearningStore(join(scratch, 'learnings.json'));
  let verifyFailures = 0;
  let endpointFiles = 0;
  let modelFiles = 0;
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (/verify failed on /.test(String(args[0]))) verifyFailures++;
    realError(...args);
  };
  const started = Date.now();
  try {
    const out = await runReview({
      source: new CaseSource(c), token: '', owner: 'bench', repo: c.id, prNumber: Number(c.id),
      workspace: c.workspace, fullReview: true, dryRun: true, store,
      configOverrides: {
        endpoint: m.endpoint, endpoints: [m.endpoint], name: m.name, verifyModel: m.verifyName ?? m.name,
        reasoningEffort: m.effort, verifyReasoningEffort: m.verifyEffort, maxTokens: m.maxTokens,
      },
      log: {
        info: () => {},
        warn: (s) => {
          if (s.startsWith('review failed for ')) { if (endpointFailure(s)) endpointFiles++; else modelFiles++; }
          realError(`    ${c.id} ${method}#${run}: ${s}`);
        },
      },
    });
    const f = bench(c.id, method, run);
    return {
      caseId: c.id, method, run,
      findings: out.result.findings.map(f),
      refuted: out.refuted.map((x: Finding, i) => f(x, 1000 + i)),
      wallMs: Date.now() - started,
      promptTokens: out.usage.promptTokens, completionTokens: out.usage.completionTokens,
      failedFiles: modelFiles,
      ...(degraded(verifyFailures, endpointFiles)),
    };
  } catch (e) {
    return { caseId: c.id, method, run, findings: [], refuted: [], wallMs: Date.now() - started,
      promptTokens: 0, completionTokens: 0, error: String(e).slice(0, 300) };
  } finally {
    console.error = realError;
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function degraded(verifyFailures: number, endpointFiles: number): { error?: string } {
  const why = [
    ...(verifyFailures ? [`${verifyFailures} verify call(s) failed and were upheld by default`] : []),
    ...(endpointFiles ? [`${endpointFiles} file(s) lost to the endpoint`] : []),
  ];
  return why.length ? { error: why.join('; ') } : {};
}

const RAW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['path', 'start_line', 'end_line', 'title', 'body'],
        properties: {
          path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' },
          title: { type: 'string' }, body: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * The baseline: the same model, one call, given the task and nothing else - no
 * sampling, no retrieval, no verification. What the pipeline adds is measured
 * against this, and if it adds nothing the pipeline is cost without benefit.
 */
export async function runRaw(c: Case, m: ModelSetting, run: number): Promise<Run> {
  const method = methodKey('raw', m);
  const cfg: ReviewpassConfig = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-raw-')));
  cfg.model.endpoint = m.endpoint;
  cfg.model.endpoints = [m.endpoint];
  cfg.model.name = m.name;
  cfg.model.reasoningEffort = m.effort;
  const diff = execFileSync('git', ['-C', c.workspace, 'diff', '--no-renames', `${c.base}...${c.head}`],
    { encoding: 'utf8', maxBuffer: 1e9 });
  const paths = execFileSync('git', ['-C', c.workspace, 'diff', '--name-only', '--no-renames', `${c.base}...${c.head}`],
    { encoding: 'utf8' }).split('\n').filter(Boolean);
  // Same per-file ceiling reviewpass applies, so neither side reads more than the other.
  const files = paths.filter((p) => existsSync(join(c.workspace, p))).map((p) => {
    const text = readFileSync(join(c.workspace, p), 'utf8');
    return text.length <= 60_000 ? `### ${p}\n\`\`\`\n${text}\n\`\`\`` : `### ${p}\n(omitted: ${text.length} characters)`;
  });
  const user = [
    `# Pull request: ${c.title}`, c.body || '(no description)',
    '## Diff', '```diff', diff, '```',
    '## Changed files as they stand after the change', ...files,
  ].join('\n\n');
  const client = new ModelClient(cfg);
  const started = Date.now();
  try {
    const r = await client.json<{ findings: { path: string; start_line: number; end_line: number; title: string; body: string }[] }>([
      { role: 'system', content: 'Review this pull request. Report the real defects the change introduces, each with the file and lines it concerns.' },
      { role: 'user', content: user },
    ], RAW_SCHEMA, { maxTokens: Math.max(m.maxTokens, 32_768), temperature: cfg.model.temperature });
    const f = bench(c.id, method, run);
    const found = (Array.isArray(r.value?.findings) ? r.value.findings : [])
      .filter((x) => Number.isFinite(x.start_line) && typeof x.title === 'string');
    return {
      caseId: c.id, method, run,
      findings: found.map((x, i) => f({ path: x.path, startLine: x.start_line, endLine: x.end_line, title: x.title, body: x.body ?? '' }, i)),
      refuted: [], wallMs: Date.now() - started,
      promptTokens: client.usage.promptTokens, completionTokens: client.usage.completionTokens,
    };
  } catch (e) {
    return { caseId: c.id, method, run, findings: [], refuted: [], wallMs: Date.now() - started,
      promptTokens: client.usage.promptTokens, completionTokens: client.usage.completionTokens, error: String(e).slice(0, 300) };
  }
}
