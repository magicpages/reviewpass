import { createHash } from 'node:crypto';
import type { ModelClient } from '../model/client.js';
import type { ReviewpassConfig } from '../config/index.js';
import type { Finding, PullRequestContext, ReviewUnit, PreMergeCheck } from '../types.js';
import {
  FINDINGS_SCHEMA, VERDICT_SCHEMA, GROUP_VERDICT_SCHEMA, WALKTHROUGH_SCHEMA, CHECKS_SCHEMA, type RawFinding,
} from './schemas.js';
import {
  REVIEWER_SYSTEM, VERIFIER_SYSTEM, WALKTHROUGH_SYSTEM, CHECKS_SYSTEM,
  buildFindingPrompt, buildVerifyPrompt, buildGroupVerifyPrompt, truncate,
} from './prompt.js';

const SEVERITY_RANK = { trivial: 0, minor: 1, major: 2, critical: 3 } as const;

/**
 * A finding's identity is its file, its title and roughly where it sits — not
 * its exact line, so that an unrelated edit above it does not make it "new" on
 * the next incremental run.
 */
export function fingerprint(path: string, title: string, line: number): string {
  const bucket = Math.floor(line / 20);
  return createHash('sha1')
    .update(`${path}|${title.toLowerCase().replace(/[^a-z0-9 ]/g, '')}|${bucket}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * What each pass of the find stage is looking for.
 *
 * Sampling the same prompt twice and unioning the results was measured to add
 * nothing beyond the second draw - the model explores the same ground at a
 * different temperature. Giving each pass a different question does not: the
 * residual failure across this whole benchmark has been *absence* - a validation
 * not performed, a case not handled - and no amount of re-reading the diff for
 * "defects" finds those, because the diff shows what was written.
 *
 * Borrowed from a hand-written review skill that had converged on the same
 * three questions independently.
 */
const PASS_FOCUS = [
  '',
  // The second pass stays general on purpose. Replacing it with a focused one
  // was measured to *displace* rather than add: on one file the focused config
  // raised 19 candidates where two general draws raised 33, and missed all three
  // real defects there. A focused pass supplements the general sweep; it does
  // not substitute for a second look at the same ground.
  '',
  `## This pass: interactions between files

You have already been through this change once for local defects. Now look
outward. What does this change assume about code it does not contain - a caller,
a schema, a test, a contract on the other side of an import? Where two changed
files must agree, check that they do. Where one changed file must agree with an
unchanged one, check that too.`,
  `## This pass: what the code does NOT do

Assume defects remain and that they are absences rather than mistakes. A diff
shows what was written; it cannot show what was left out, and that is where this
review most often fails.

Go through the change asking only: what is missing? A validation not performed,
an error path not handled, a case the switch does not cover, a row the migration
does not touch, an assertion the test does not make, a scope not applied to a
query. Compare against the established form in the context you were given - the
blocks showing how the rest of the repository does this - and name what those do
that this does not.`,
];

/**
 * One sampling of the find pass.
 *
 * Measured: running the same file through the same model twice produces
 * different findings, and a single sample missed a defect that a second sample
 * caught. So `findInFile` draws several samples and unions them — safe to do
 * because the refutation pass supplies precision, not this one.
 */
async function sampleFindings(
  model: ModelClient,
  cfg: ReviewpassConfig,
  pr: PullRequestContext,
  unit: ReviewUnit,
  temperature: number,
  focus: string,
): Promise<RawFinding[]> {
  const prompt = buildFindingPrompt(pr, unit);
  const { value } = await model.json<{ findings: RawFinding[] }>(
    [
      { role: 'system', content: REVIEWER_SYSTEM },
      {
        role: 'user',
        content: `${truncate(prompt, cfg.model.contextBudget * 4)}${focus ? `\n\n${focus}` : ''}`,
      },
    ],
    FINDINGS_SCHEMA,
    { schemaName: 'findings', maxTokens: cfg.model.maxTokens, temperature },
  );
  return value.findings ?? [];
}

export async function findInFile(
  model: ModelClient,
  cfg: ReviewpassConfig,
  pr: PullRequestContext,
  unit: ReviewUnit,
): Promise<Finding[]> {
  const samples = Math.max(1, cfg.review.findSamples);
  const raw: RawFinding[] = [];
  for (let i = 0; i < samples; i++) {
    // Vary the temperature across samples so they explore differently; the
    // first stays cold so the most obvious defects are always reported.
    const temperature = i === 0 ? cfg.model.temperature : Math.min(0.8, cfg.model.temperature + 0.25 * i);
    try {
      raw.push(...await sampleFindings(model, cfg, pr, unit, temperature, PASS_FOCUS[i] ?? ''));
    } catch (err) {
      if (i === 0) throw err;   // a first-sample failure is a real failure
      break;                     // a later one just means fewer samples
    }
  }

  const changed = new Set(unit.file.addedLines);
  const out: Finding[] = [];
  const seen = new Set<string>();

  for (const r of raw) {
    // The model occasionally anchors to context rather than the change. Findings
    // that touch no changed line cannot be posted inline and are usually drift.
    const start = Math.min(r.start_line, r.end_line);
    const end = Math.max(r.start_line, r.end_line);
    const touchesChange = [...changed].some((l) => l >= start - 3 && l <= end + 3);
    if (!touchesChange) continue;

    if (cfg.review.profile === 'chill' && r.severity === 'trivial') continue;

    // Two samples often phrase the same defect differently; the fingerprint
    // buckets by file, normalised title and line region, which collapses them.
    const fp = fingerprint(unit.path, r.title, start);
    if (seen.has(fp)) continue;
    seen.add(fp);

    out.push({
      path: unit.path,
      startLine: start,
      endLine: end,
      severity: r.severity,
      category: r.category,
      title: r.title.trim(),
      body: r.body.trim(),
      suggestion: r.suggestion?.trim() ? r.suggestion : undefined,
      siblings: (r.siblings ?? [])
        .filter((s) => s.path && s.path !== unit.path)
        .map((s) => ({ path: s.path, startLine: s.start_line, endLine: s.end_line })),
      settledBy: r.settled_by?.quote?.trim()
        ? { path: r.settled_by.path, line: r.settled_by.line, quote: r.settled_by.quote }
        : undefined,
      fingerprint: fp,
    });
  }
  return out;
}

/**
 * Is the verifier's quoted disproof really in what it was shown?
 *
 * Whitespace and line numbers differ between the rendered context and a quote
 * copied out of it, so both sides are flattened before comparing. Very short
 * quotes are rejected outright: `}` appears in every file and proves nothing.
 */
function quoteAppearsIn(quote: string, prompt: string): boolean {
  const flatten = (s: string) => s.replace(/^\s*\d+\s/gm, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const q = flatten(quote);
  if (q.length < 12) return false;
  return flatten(prompt).includes(q);
}

/**
 * Adversarial verification. A reviewer that withdraws its own weak findings
 * of its own findings after pushback — this pass tries to do that work before
 * the author ever sees them.
 */
/**
 * Does everything this finding names actually exist?
 *
 * A finding that cites `@/middleware/raw-body` reads as authoritative and was
 * wrong in the only way that matters: the module does not exist. The reviewer
 * invented a shared helper, then complained the code did not use it. A verifier
 * cannot catch that by reasoning - it has no more idea than the finder does -
 * but the symbol graph knows every path and every declared name in the
 * repository, so the claim is decidable without asking a model at all.
 *
 * Only import-style paths and backticked identifiers are checked, and only when
 * the graph is available. Anything not recognisable as a repository reference is
 * left alone: the cost of a false drop here is a real finding deleted.
 */
/*
 * Removed: a mechanical check for "claims X is absent, but X is in the file".
 *
 * It read the presence of a named symbol as refuting a claim about that symbol,
 * which is not what such findings mean. "Does not handle `STATE_EXPIRED`"
 * almost always means "does not handle the *case*" — and the code being full of
 * `STATE_EXPIRED` is exactly what you would expect when one error code covers
 * two situations that should be told apart. It dropped that finding on a live
 * pull request.
 *
 * An earlier version of the same idea failed the same way from the other
 * direction, matching "only visits `X`" and confirming `X` was present, which
 * supports the claim rather than refuting it. Two attempts, two unsound
 * readings: absence claims are about behaviour, and a string search cannot see
 * behaviour. The verifier is told to go and look instead, which is slower and
 * correct.
 */

export function citesMissingArtifact(
  finding: { title: string; body: string },
  repoFiles: Set<string> | undefined,
): string | null {
  if (!repoFiles?.size) return null;
  const text = `${finding.title} ${finding.body}`;

  // Suffix matching, not path joining. `@/lib/logger` resolves through a
  // tsconfig alias to `apps/api/src/lib/logger.ts`, and joining it onto the
  // workspace root reports a file that plainly exists as missing - which would
  // delete real findings, the one outcome this check must never produce.
  const known = [...repoFiles];
  const resolves = (ref: string) => {
    const stem = ref.replace(/^[@~]\//, '').replace(/\.[jt]sx?$/, '').replace(/^\.\//, '');
    if (stem.length < 4) return true;               // too short to judge
    return known.some((p) => {
      const q = p.replace(/\.[jt]sx?$/, '');
      return q === stem || q.endsWith(`/${stem}`) || q.endsWith(`/${stem}/index`);
    });
  };

  for (const m of text.matchAll(/`(@\/[\w./-]+|[\w-]+\/[\w./-]+\.[jt]sx?)`/g)) {
    const ref = m[1]!;
    // A trailing slash means a directory, and a finding is entitled to name one
    // ("extract this to a helper under `@/lib/testing/`") without claiming a
    // module exists there. Treating those as modules dropped four sound
    // findings on a single pull request — the failure this check exists to
    // avoid, committed by the check itself.
    if (ref.endsWith('/')) continue;
    if (!resolves(ref)) return ref;
  }
  return null;
}

/**
 * Severity, reconciled with what verification concluded.
 *
 * The find pass assigns severity before anything is checked; the verifier rates
 * importance having read the whole file and the change's stated purpose. When
 * they disagree the verifier is better informed, and it disagreed a lot: on a
 * 22-file pull request, 20 of 52 findings came back MAJOR, among them three
 * asking that a test regex match case-sensitively — labelled `MAJOR stability`.
 *
 * Severity is only ever lowered. Raising it would let a rating overrule a finder
 * that saw something the scale does not capture, and a review that inflates its
 * own labels is the failure being fixed here — so the correction runs one way.
 */
function severityFor(severity: Finding['severity'], importance: number): Finding['severity'] {
  const ceiling: Finding['severity'] =
    importance >= 8 ? 'critical'
    : importance >= 6 ? 'major'
    : importance >= 3 ? 'minor'
    : 'trivial';
  const rank = { trivial: 0, minor: 1, major: 2, critical: 3 } as const;
  return rank[ceiling] < rank[severity] ? ceiling : severity;
}

export interface VerifyDeps {
  /** Resolve and read the files a finding names, so its claims can be checked. */
  filesNamedIn?: (f: Finding) => Promise<{ label: string; text: string }[]>;
}

export async function verify(
  model: ModelClient,
  cfg: ReviewpassConfig,
  finding: Finding,
  unit: ReviewUnit,
  pr?: PullRequestContext,
  deps?: VerifyDeps,
): Promise<Finding> {
  try {
    const withNamed = deps?.filesNamedIn
      ? { ...unit, namedFiles: await deps.filesNamedIn(finding) }
      : unit;
    const prompt = buildVerifyPrompt(finding, withNamed, pr && { title: pr.title, body: pr.body });
    const { value } = await model.json<{
      correct: boolean; in_scope: boolean; importance: number; disproof?: string; reason: string; confidence: number;
    }>(
      [
        { role: 'system', content: VERIFIER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      VERDICT_SCHEMA,
      { schemaName: 'verdict', model: cfg.model.verifyModel ?? cfg.model.name, maxTokens: 2048 },
    );

    // Two gates, and only two: is it true, and does it belong on this change.
    // Importance is carried for ranking and never gates - dropping on it cost
    // 63% of the real defects when it was tried, and a true, in-scope finding
    // that happens to be small is still worth the author's eye.
    let importance = Math.max(1, Math.min(10, Math.round(value.importance ?? 5)));

    // A finding whose title asks the author to go and check something is far
    // less likely to be acted on than one that reports a defect outright: it
    // hands the work back rather than doing it. Demoted rather than dropped,
    // because a minority of them are real - they rank below anything concrete,
    // and the reader reaches them last or not at all.
    if (/^\s*(ensure|verify|confirm|make sure|check)\b/i.test(finding.title)) {
      importance = Math.min(importance, 4);
    }
    // Occasionally the find pass reasons its way to "no change needed" and
    // reports it anyway. Posting that wastes the reader's attention on the
    // reviewer's own discarded hypothesis - seen once on a live pull request.
    // Then seen seven times on one file of another, because the withdrawal was
    // announced in the title ("TTL index is well-defined - no change needed")
    // while the body read like an ordinary finding, and only the body was
    // checked. Both halves are read now.
    // Two patterns, because the two fields carry different risk. A body may
    // legitimately say "no migration is needed" while reporting a real defect,
    // so it is matched narrowly. A *title* that announces the absence of a
    // problem is the whole comment's headline and is never a real finding.
    const withdrawnAnywhere = /\b(no change (is )?(needed|required)|this is (fine|correct) as written|no action (needed|required)|no defect\b|identifies no defect|not a defect|nothing to change)\b/i;
    const withdrawnInTitle = /\b(no finding|correctly implemented|not a problem|already (done|present|handled)|no \w+ (is |are )?(needed|required))\b|\bis correct\b/i;
    // The conclusion lands last. A finding can spend eight hundred characters
    // building a case and end "So this is actually correct. Withdrawing this
    // finding." - the retraction is structural, at the tail, and looking for it
    // there catches phrasings a fixed vocabulary never will. Chasing the
    // wording alone took three pull requests and six distinct spellings.
    const withdrawnAtEnd = /\b(withdraw\w*|actually correct|is correct|no defect|not a (defect|problem|bug)|already (done|present|handled|in place)|no change (is )?(needed|required))\b/i;
    const selfWithdrawn = withdrawnAnywhere.test(`${finding.title} ${finding.body}`)
      || withdrawnInTitle.test(finding.title)
      || withdrawnAtEnd.test(finding.body.slice(-220));
    const kept = value.correct && value.in_scope !== false && !selfWithdrawn;
    const why = !value.correct ? 'incorrect'
      : value.in_scope === false ? 'out of scope'
      : selfWithdrawn ? 'withdrawn by its own reasoning' : '';

    return {
      ...finding,
      severity: severityFor(finding.severity, importance),
      verdict: kept ? 'upheld' : 'refuted',
      verdictReason: why ? `${why}: ${value.reason}` : value.reason,
      confidence: value.confidence,
      importance,
    };
  } catch (err) {
    // A verifier that cannot run must not silently drop real findings. But it
    // must not hide *why* it could not run either: swallowing the cause turned
    // two prompt evaluations into 60-of-60 upholds that read as a real result
    // and were nothing but a failing model call.
    if (process.env.REVIEWPASS_DEBUG) console.error(`  verify failed on ${finding.path}:${finding.startLine} — ${String(err).slice(0, 200)}`);
    return { ...finding, verdict: 'upheld', verdictReason: `verification unavailable: ${String(err).slice(0, 120)}`, confidence: 0.5 };
  }
}

/**
 * Collapse findings that say the same thing.
 *
 * Sampling the find pass twice surfaces the same defect phrased differently, so
 * exact fingerprints are not enough: two titles for one bug produce two
 * fingerprints and the author sees the comment twice. Overlapping line ranges in
 * the same file plus substantial word overlap is the practical test.
 */
export function collapseNearDuplicates(findings: Finding[]): Finding[] {
  /**
   * Crude suffix stripping, so `continue`/`continuing` and `skip`/`skipped`
   * count as the same word. Without it three phrasings of one defect — "log and
   * continue", "log and count the skipped", "distinguish a failed upsert" —
   * all reached the author as separate comments.
   */
  const stem = (w: string) =>
    w.replace(/(ingly|edly|ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');

  const words = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3)
      .map(stem)
      .filter((w) => w.length > 2),
  );
  const overlap = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let n = 0;
    for (const w of a) if (b.has(w)) n++;
    return n / Math.min(a.size, b.size);
  };

  const kept: (Finding & { _words: Set<string>; _argument: Set<string> })[] = [];
  for (const f of findings) {
    // The first sentence of the body carries the claim; titles alone were too
    // thin a signal to tell a restatement from a distinct defect.
    const w = words(`${f.title} ${firstSentence(f.body)}`);
    // Tuned against real output. Too loose (0.45 / 12 lines) collapsed distinct
    // defects in one function and discarded a real finding; too tight (0.7 /
    // 3 lines) let three phrasings of the same defect through. Anchors must sit
    // in the same region and the titles must be mostly the same words.
    // Two signals, and the stronger one decides. Measured on a real review that
    // posted both halves of two duplicate pairs: one pair agreed on its title
    // (0.86) but diverged in the body (0.43), the other did the opposite (0.25
    // title, 0.50 body). Averaging them into a single number let both through;
    // taking the max catches both and still scores an unrelated pair at 0.00.
    const titleWords = words(f.title);
    // The same argument made about a different literal. Two findings asked for
    // an exact-case assertion on two different link texts; each quoted its own
    // string, so the wording agreed on the reasoning and disagreed on the nouns,
    // scoring below every threshold above. Stripping backticked code and quoted
    // text leaves the argument itself, which is what makes them one finding.
    const argument = words(stripLiterals(`${f.title} ${firstSentence(f.body)}`));
    const similarity = (k: (typeof kept)[number]) =>
      Math.max(overlap(w, k._words), overlap(titleWords, words(k.title)));

    // Findings whose anchors actually intersect are far more likely to be one
    // defect than findings that merely sit near each other, so the bar is lower
    // there. Loosening it everywhere was tried earlier and merged real, distinct
    // defects in a single function.
    const intersects = (k: (typeof kept)[number]) =>
      f.startLine <= k.endLine && k.startLine <= f.endLine;

    const sameRegion = kept.find((k) =>
      k.path === f.path &&
      (intersects(k)
        ? similarity(k) >= 0.45
        : f.startLine <= k.endLine + 6 && k.startLine <= f.endLine + 6 && similarity(k) >= 0.6));

    // Same file, distant lines, same claim. The region rule above needs the
    // anchors to be near each other and the cross-file rule below needs near
    // identical wording, so a file that drew three separate findings about
    // `console.log` at lines 75, 101 and 103 satisfied neither and all three
    // were posted. Within one file, the wording alone is enough.
    const sameFileFarApart = sameRegion ?? kept.find((k) =>
      k.path === f.path && similarity(k) >= 0.72);

    // One root cause reported at two locations is still one finding. A defect in
    // a helper and the same defect observed at its call site, or in the source
    // file and again in its test, arrived as two comments because the line-range
    // test only ever compared within a file - a real review of a signature
    // mismatch reported it once in the implementation and once in the test.
    // Across files the wording has to agree more closely, since two files can
    // legitimately have similar-sounding but distinct problems.
    const sameCause = kept.find((k) => k.path !== f.path && similarity(k) >= 0.8);

    // Same argument, different literal — reported once, with the other sites
    // listed. Unlike the rules above this does not discard anything: the second
    // location is real and the author needs to see it, but as part of one
    // comment rather than as a second comment repeating the reasoning.
    const sameArgument = kept.find((k) => k.path === f.path && overlap(argument, k._argument) >= 0.8);

    const twin = sameRegion ?? sameFileFarApart ?? sameCause;
    if (!twin && sameArgument) {
      sameArgument.siblings = [
        ...(sameArgument.siblings ?? []),
        { path: f.path, startLine: f.startLine, endLine: f.endLine },
      ];
      continue;
    }
    if (twin) {
      // Keep whichever sits closest to the cause rather than the symptom: a
      // finding in the implementation beats the same finding in its test, and
      // one that ships a fix beats one that does not.
      const isTest = (p: string) => /\.(test|spec)\.|__tests__\//.test(p);
      const better =
        isTest(twin.path) && !isTest(f.path) ? true
        : !isTest(twin.path) && isTest(f.path) ? false
        : !twin.suggestion && Boolean(f.suggestion);
      if (better) Object.assign(twin, f, { _words: w, _argument: argument });
      continue;
    }
    kept.push(Object.assign({ _words: w, _argument: argument }, f));
  }
  return kept.map(({ _words, _argument, ...f }) => f as Finding);
}

/** Backticked code and quoted text removed, leaving the claim being made. */
function stripLiterals(s: string): string {
  return s.replace(/`[^`]*`/g, ' ').replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

function firstSentence(s: string): string {
  return (/^[^.!?]{0,240}[.!?]/.exec(s.trim())?.[0] ?? s.slice(0, 160));
}

/**
 * At most a couple of findings on any one piece of code.
 *
 * A human reviewer almost never leaves three comments on the same ten lines: one
 * remark per piece of code, occasionally two, effectively never more. It was
 * emitting three differently-worded findings about
 * a single upsert, which reads as noise however individually defensible each is.
 * Where several survive, the most severe and most actionable one speaks for the
 * rest.
 */
/**
 * Findings whose anchors overlap, grouped so they can be judged together.
 *
 * Verifying each candidate in isolation let two descriptions of one defect
 * receive opposite verdicts on the same pull request: one was posted saying a
 * test "does not verify the 3-day warning", the other refuted saying "the
 * existing test already verifies their names, data, and times". Both cannot be
 * true, and nothing in the pipeline could notice because the two calls never
 * met. Lexical dedup had not merged them either - the titles share almost no
 * words, which is exactly the case string similarity cannot reach.
 *
 * Grouping by overlapping range is the cheap structural fix: one verdict per
 * piece of code, so a contradiction has to be resolved rather than posted.
 */

/**
 * Verify every finding on one region in a single call.
 *
 * Cheaper than one call per finding, and it is the only arrangement in which a
 * contradiction between two findings can be noticed at all: they are judged
 * against one reading of the same code, by the same call.
 */
export async function verifyGroup(
  model: ModelClient,
  cfg: ReviewpassConfig,
  findings: Finding[],
  unit: ReviewUnit,
  pr?: PullRequestContext,
  deps?: VerifyDeps,
): Promise<Finding[]> {
  if (findings.length === 1) return [await verify(model, cfg, findings[0]!, unit, pr, deps)];

  try {
    // Every file any finding in the group names, gathered once for the group.
    const named = deps?.filesNamedIn
      ? (await Promise.all(findings.map((f) => deps.filesNamedIn!(f)))).flat()
      : [];
    const seen = new Set<string>();
    const withNamed = named.length
      ? { ...unit, namedFiles: named.filter((n) => !seen.has(n.label) && seen.add(n.label)).slice(0, 4) }
      : unit;
    const prompt = buildGroupVerifyPrompt(findings, withNamed, pr && { title: pr.title, body: pr.body });
    const { value } = await model.json<{
      verdicts: { index: number; correct: boolean; in_scope: boolean; importance: number; duplicate_of: number; reason: string }[];
    }>(
      [{ role: 'system', content: VERIFIER_SYSTEM }, { role: 'user', content: prompt }],
      GROUP_VERDICT_SCHEMA,
      { schemaName: 'group_verdict', model: cfg.model.verifyModel ?? cfg.model.name, maxTokens: 4096 },
    );

    const byIndex = new Map(value.verdicts.map((v) => [v.index, v]));
    return findings.map((f, i) => {
      const v = byIndex.get(i);
      // A finding the verifier did not answer for is kept: silence is not a
      // refutation, and dropping it would delete a finding on a technicality.
      if (!v) return { ...f, verdict: 'upheld' as const, verdictReason: 'no verdict returned', confidence: 0.5 };

      const duplicate = v.duplicate_of >= 0 && v.duplicate_of < findings.length && v.duplicate_of !== i;
      let importance = Math.max(1, Math.min(10, Math.round(v.importance ?? 5)));
      if (/^\s*(ensure|verify|confirm|make sure|check)\b/i.test(f.title)) importance = Math.min(importance, 4);

      const kept = v.correct && v.in_scope !== false && !duplicate;
      const why = duplicate ? `duplicate of finding ${v.duplicate_of}`
        : !v.correct ? 'incorrect'
        : v.in_scope === false ? 'out of scope' : '';

      return {
        ...f,
        severity: severityFor(f.severity, importance),
        verdict: kept ? ('upheld' as const) : ('refuted' as const),
        verdictReason: why ? `${why}: ${v.reason}` : v.reason,
        confidence: 0.9,
        importance,
      };
    });
  } catch {
    // Fall back to judging them individually rather than losing the region.
    return Promise.all(findings.map((f) => verify(model, cfg, f, unit, pr, deps)));
  }
}

export function groupByRegion(findings: Finding[]): Finding[][] {
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byPath.get(f.path) ?? [];
    list.push(f);
    byPath.set(f.path, list);
  }

  const groups: Finding[][] = [];
  for (const list of byPath.values()) {
    const sorted = [...list].sort((a, b) => a.startLine - b.startLine);
    let current: Finding[] = [];
    let end = -1;
    for (const f of sorted) {
      if (current.length && f.startLine <= end) {
        current.push(f);
        end = Math.max(end, f.endLine);
      } else {
        if (current.length) groups.push(current);
        current = [f];
        end = f.endLine;
      }
    }
    if (current.length) groups.push(current);
  }
  return groups;
}

export function capPerRegion(findings: Finding[], perRegion = 2): Finding[] {
  const count = new Map<string, number>();
  const out: Finding[] = [];
  // Assumes the caller has already ordered by usefulness.
  for (const f of findings) {
    const key = `${f.path}:${Math.floor(f.startLine / 10)}`;
    const n = count.get(key) ?? 0;
    if (n >= perRegion) continue;
    count.set(key, n + 1);
    out.push(f);
  }
  return out;
}

/**
 * A request for more test coverage, rather than a report of a defect.
 *
 * These are true, in scope, and worth almost nothing individually. On a pull
 * request that added a lot of tests, twenty of twenty-five findings asked for
 * another assertion, and the one finding that described an actual bug -
 * orphaned objects in storage after a partial upload - sat nineteenth. Both
 * verification gates pass them correctly: the test really does not assert that.
 *
 * They are not dropped. A missing assertion is a real gap and the author may
 * well want it. They are ranked under anything that describes something the
 * code does wrong, because a reader's attention runs out long before the list
 * does, and it should run out on the defects.
 */
function isCoverageRequest(f: Finding): boolean {
  const onTestFile = /\.(test|spec)\.[jt]sx?$|__tests__\//.test(f.path);
  const asksForCoverage =
    /^\s*(add|write)\b.*\b(test|tests|case|coverage)\b/i.test(f.title) ||
    /^\s*(assert|test|verify)\b/i.test(f.title) ||
    /\bdoes not assert\b|\bis not asserted\b|\bno assertion\b/i.test(f.title);
  // File location is a hint, not the rule. "Test the PDF function" is a request
  // for coverage wherever it is anchored - it was anchored on the source file
  // and so ranked first, above the defect it was meant to sit under. An
  // assertion-shaped title is only a coverage request on a test file, though:
  // "assert the signature is valid" about production code is a real finding.
  const explicit = /^\s*(add|write|test)\b/i.test(f.title);
  return asksForCoverage && (onTestFile || explicit);
}

export function rankAndCap(findings: Finding[], max: number): Finding[] {
  return capPerRegion(collapseNearDuplicates(findings))
    .sort((a, b) => {
      // Defects first, whatever their importance. This is the one ordering rule
      // that does not go through importance, because the two kinds are not
      // comparable on that scale: a missing assertion and a data-loss bug can
      // both be rated 4 and only one of them is why anybody opened the review.
      const cov = Number(isCoverageRequest(a)) - Number(isCoverageRequest(b));
      if (cov !== 0) return cov;
      // The verifier's importance leads, because it judged the finding against
      // the whole file while severity was assigned by the find pass before any
      // of that was checked - and severity was measured to be a weak predictor
      // of whether a finding was acted on.
      const imp = (b.importance ?? 5) - (a.importance ?? 5);
      if (imp !== 0) return imp;
      const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (s !== 0) return s;
      // A finding that ships a fix is more useful than one that does not.
      return Number(Boolean(b.suggestion)) - Number(Boolean(a.suggestion));
    })
    .slice(0, max);
}

/**
 * The review verdict. Deliberately conservative about blocking: a reviewer that
 * cries wolf gets muted, and the acceptance data showed severity is a weak
 * signal, so only findings that survived refutation can request changes.
 */
export function decideEvent(
  findings: Finding[],
  cfg: ReviewpassConfig,
  hadFailure: boolean,
  openFindings = 0,
): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  const threshold = SEVERITY_RANK[cfg.review.requestChangesAt];
  const blocking = findings.filter((f) => SEVERITY_RANK[f.severity] >= threshold);

  if (blocking.length) return 'REQUEST_CHANGES';

  // An approval speaks for the whole pull request, not for the commits this
  // pass happened to read.
  //
  // An incremental review reads only what is new, so a push that touches
  // nothing reviewable - a CI fix, a lockfile bump - finds nothing and used to
  // approve on the strength of it. On a real pull request that retracted a
  // finding nobody had answered: reviewed at 20:10 with one finding open,
  // approved at 05:51 saying "Nothing to raise", with the thread still open.
  //
  // Finding nothing new is not the same as having nothing to say.
  if (findings.length === 0 && openFindings > 0) return 'COMMENT';

  if (findings.length === 0 && cfg.review.approveWhenClean && !hadFailure) return 'APPROVE';
  return 'COMMENT';
}

export async function summarise(
  model: ModelClient,
  cfg: ReviewpassConfig,
  pr: PullRequestContext,
): Promise<{
  summary: string;
  groups: { label: string; summary: string; files: string[] }[];
  effort: { score: number; label: string };
  mergeRisk: 'minimal' | 'low' | 'moderate' | 'high';
  mergeRiskReason: string;
}> {
  const fileList = pr.files
    .map((f) => `${f.path} (+${f.additions}/-${f.deletions})`)
    .join('\n');
  const diffs = pr.files
    .map((f) => `--- ${f.path} ---\n${truncate(f.patch ?? '', 4000)}`)
    .join('\n\n');

  const { value } = await model.json<{
    summary: string;
    groups: { label: string; summary: string; files: string[] }[];
    effort_score: number;
    effort_label: string;
    merge_risk: 'minimal' | 'low' | 'moderate' | 'high';
    merge_risk_reason: string;
  }>(
    [
      { role: 'system', content: WALKTHROUGH_SYSTEM },
      {
        role: 'user',
        content: [
          `# Pull request #${pr.number}: ${pr.title}`,
          pr.body.trim() ? truncate(pr.body, 1200) : '(no description)',
          '\n# Files changed\n', fileList,
          '\n# Diffs\n', truncate(diffs, cfg.model.contextBudget * 2),
          '\nSummarise this pull request. Return JSON matching the schema.',
        ].join('\n'),
      },
    ],
    WALKTHROUGH_SCHEMA,
    { schemaName: 'walkthrough', maxTokens: 3072 },
  );

  return {
    summary: value.summary,
    groups: value.groups ?? [],
    effort: { score: value.effort_score, label: value.effort_label },
    mergeRisk: value.merge_risk,
    mergeRiskReason: value.merge_risk_reason,
  };
}

export async function runChecks(
  model: ModelClient,
  cfg: ReviewpassConfig,
  pr: PullRequestContext,
): Promise<PreMergeCheck[]> {
  const wanted = [
    cfg.checks.title && 'Title check',
    cfg.checks.description && 'Description check',
    cfg.checks.linkedIssues && 'Linked issues check',
    cfg.checks.outOfScope && 'Out of scope changes check',
  ].filter(Boolean) as string[];
  if (!wanted.length) return [];

  try {
    const { value } = await model.json<{ checks: PreMergeCheck[] }>(
      [
        { role: 'system', content: CHECKS_SYSTEM },
        {
          role: 'user',
          content: [
            `# Title\n${pr.title}`,
            `\n# Description\n${pr.body.trim() || '(empty)'}`,
            `\n# Linked issues\n${pr.linkedIssues.length ? pr.linkedIssues.map((n) => `#${n}`).join(', ') : '(none referenced)'}`,
            `\n# Files changed\n${pr.files.map((f) => f.path).join('\n')}`,
            `\n# Run exactly these checks: ${wanted.join(', ')}`,
            'Return JSON matching the schema.',
          ].join('\n'),
        },
      ],
      CHECKS_SCHEMA,
      { schemaName: 'checks', maxTokens: 2048 },
    );
    return (value.checks ?? []).filter((c) => wanted.includes(c.name));
  } catch {
    return [];
  }
}

/**
 * How much two findings are making the same claim.
 *
 * The same comparison `collapseNearDuplicates` uses, exposed so a claim can be
 * matched against one that verification already disproved. Literal-stripped,
 * because the same argument about the same defect gets written with different
 * identifiers depending on which file it was anchored to.
 */
export function claimOverlap(
  a: { title: string; body: string },
  b: { title: string; body: string },
): number {
  const stem = (w: string) => w.replace(/(ingly|edly|ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');
  const words = (t: string) => new Set(
    t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3).map(stem).filter((w) => w.length > 2),
  );
  const overlap = (x: Set<string>, y: Set<string>) => {
    if (!x.size || !y.size) return 0;
    let n = 0;
    for (const w of x) if (y.has(w)) n++;
    return n / Math.min(x.size, y.size);
  };
  const claim = (f: { title: string; body: string }) => `${f.title} ${firstSentence(f.body)}`;
  return Math.max(
    overlap(words(a.title), words(b.title)),
    overlap(words(stripLiterals(claim(a))), words(stripLiterals(claim(b)))),
  );
}

/**
 * Do not post a finding that verification disproved somewhere else.
 *
 * Verification groups findings by region, so a claim raised against three files
 * is judged three times against three sets of evidence — and only the group
 * holding the call site gets the evidence that settles it. On a pull request
 * that made a schema field required, one instance was refuted because the write
 * path only ever handles a freshly created record, and three instances of the
 * same claim were upheld elsewhere. One escalated to critical and blocked the
 * pull request on a claim the reviewer had already disproved in the same run.
 *
 * Only `incorrect` refutations propagate. A `duplicate` refutation is not a
 * disproof — it means the claim is true and is being reported once, through the
 * finding that survived — so treating it as one would delete the survivor too.
 * An `out of scope` refutation is about *this* change and can be right in one
 * file and wrong in another, so it does not travel either.
 */
export function reconcileWithRefutations(
  kept: Finding[],
  refuted: Finding[],
  log: (m: string) => void = () => {},
): { kept: Finding[]; overturned: Finding[] } {
  const disproved = refuted.filter((f) => /^incorrect\b/i.test(f.verdictReason ?? ''));
  if (!disproved.length) return { kept, overturned: [] };

  const overturned: Finding[] = [];
  const survivors = kept.filter((f) => {
    // Calibrated on the run this exists to fix: the two restatements of the
    // disproved claim scored 0.57 and 0.50, while the closest pair that must
    // survive - a rule violation the maintainer went on to fix - scored 0.42.
    // That pair is also a `duplicate` rather than `incorrect`, so it is out of
    // this set already; the margin is the second line of defence, not the first.
    const match = disproved.find((d) => claimOverlap(f, d) >= 0.5);
    if (!match) return true;
    log(`  dropped "${f.title.slice(0, 62)}" — disproved on ${match.path}`);
    overturned.push({ ...f, verdict: 'refuted', verdictReason: match.verdictReason });
    return false;
  });
  return { kept: survivors, overturned };
}

/**
 * A request for a whole new test, where the thing to be tested is already
 * exercised somewhere in the suite.
 *
 * Measured over 107 findings the maintainer triaged on nine pull requests, the
 * two shapes behave nothing alike. "Add a test for X" was raised eight times
 * and rejected eight times. "Assert X in the existing test" was raised eleven
 * times and applied nine. There is a mechanism behind the split rather than
 * just a correlation: by the time a reviewer runs, the author has already
 * written the tests that go with the change, so a demand for a *new* test is
 * usually redundant with one already in the diff, while a demand for a
 * *stronger assertion* inside those new tests is a real gap nobody has filled.
 *
 * The coverage check is the safety valve. A change that genuinely ships with no
 * test at all must still be caught, so the finding only dies when the symbol it
 * names is already referenced from a test file.
 */
const ASKS_FOR_NEW_TEST =
  /^\s*(add|write|missing)\b[^.]{0,60}\btests?\b|^\s*add test coverage|^\s*test (the|a) \w+ (function|case|branch)/i;

export function redundantTestRequest(
  finding: { title: string; body: string },
  testedSymbols: Set<string> | undefined,
): string | null {
  if (!testedSymbols?.size) return null;
  if (!ASKS_FOR_NEW_TEST.test(finding.title)) return null;

  // The symbol under test: prefer a backticked identifier, which is how the
  // find pass names the thing it wants covered.
  const named = [
    ...finding.title.matchAll(/`([A-Za-z_$][\w$.]{7,})`/g),
    ...finding.body.slice(0, 400).matchAll(/`([A-Za-z_$][\w$.]{7,})`/g),
  ].flatMap((m) => {
    const root = m[1]?.split('.')[0];
    return root ? [root] : [];
  });

  for (const sym of named) {
    // Only a distinctive name settles anything. `href` and `findOneAndUpdate`
    // appear in nearly every test file in a repository, so matching on them
    // would retire findings about code nobody has tested. A name has to be
    // long and compound enough to belong to this change.
    if (sym.length < 8 || !/[A-Z]/.test(sym.slice(1))) continue;
    if (testedSymbols.has(sym)) return sym;
  }
  return null;
}

/** Where a finding says the proof of its claim lives. */
export type Citation = { path: string; line: number; quote: string };

/**
 * Whether the evidence a finding cites is really there.
 *
 * Of 141 findings a maintainer rejected across 29 pull requests, the largest
 * group by far - 30 of them - was answered with a pointer: "already covered by
 * the test at :174", "the only consumer is DomainService.updateDomain",
 * "`Upload.abort()` cannot throw, it is `async abort()` in the SDK", "the
 * production code already lowercases this". Every one of those refutations
 * names a location. The finding that provoked it named none, because nothing
 * ever required it to look.
 *
 * So a finding now has to quote the line that settles it, and the quote has to
 * be found there. A claim about code the reviewer did not read cannot produce
 * one; a claim about code it did read costs nothing. This does not check that
 * the evidence supports the conclusion - no cheap test can - but it does check
 * that the evidence exists, which the fabricated claims could not survive.
 *
 * Whitespace and quote style are normalised away: the model retypes a line
 * rather than copying bytes, and failing it for a changed indent would retire
 * true findings to punish a formatting difference.
 */
export function citationResolves(
  citation: Citation | undefined,
  readFile: (path: string) => string | null,
): { ok: true } | { ok: false; why: string } {
  if (!citation) return { ok: false, why: 'no evidence cited' };
  const { path, line, quote } = citation;
  if (typeof path !== 'string' || !path.trim()) return { ok: false, why: 'evidence names no file' };
  if (!quote || quote.trim().length < 4) return { ok: false, why: 'evidence quote is empty' };

  const text = readFile(path);
  if (text === null) return { ok: false, why: `cited file ${path} is not in this workspace` };

  const lines = text.split('\n');
  // Retyping, not copying: the model reproduces a line from memory, so quote
  // style, indentation and spaces around punctuation all drift. Normalising
  // them away costs nothing, and failing a true finding over a reformatted
  // comma would trade one kind of error for another.
  const norm = (s: string) => s
    .replace(/['"`]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;:{}\[\]])\s*/g, '$1')
    .trim()
    .toLowerCase();
  const needle = norm(quote);

  // A window, not an exact line. Line numbers drift by a few when the model
  // counts a hunk header or a blank, and a finding should not die for that.
  // The file flattened, so a quote spanning two or three lines still resolves.
  // Matching line by line rejected every multi-line quote, and the prompt asks
  // for the line "as it appears" without promising it is only one.
  // Normalised as one string, not joined from normalised lines: the join adds a
  // space the needle does not have, so `{ return` would never match `{return`.
  const flat = norm(lines.join(' '));
  if (flat.includes(needle)) return { ok: true };

  // Nothing else counts. An earlier version also accepted a quote that
  // *contained* a real line, on the theory that the model had quoted generously.
  // It had not: "return true; and this is never awaited" contains "return true;"
  // and passes, which is precisely the fabrication the citation exists to catch.
  // A quote is either in the file or it is not.
  return { ok: false, why: `quoted line is not in ${path} near :${line}` };
}

/**
 * A guard demanded for a state the schema does not permit.
 *
 * The largest single class of rejected findings, across 156 of them: the
 * reviewer sees `record.lockedAt.toISOString()` and asks what happens when
 * `lockedAt` is null. Whether it can be null is not decided at the call site.
 * It is decided two files away, in one line of schema that is sitting in the
 * repository - `lockedAt: { type: Date, required: true }` - and on one pull
 * request the same question was asked four times about four required fields,
 * drawing the same paragraph in reply four times.
 *
 * The wording is a weak signal on its own: findings phrased this way are
 * accepted about as often as any other, so a gate keyed on phrasing alone
 * removes as much signal as noise. The discrimination comes entirely from the
 * schema, which is why the trigger is broad and the condition is narrow: a
 * field that is not found required simply is not settled, and the finding
 * stands.
 */
const ASKS_FOR_A_GUARD =
  /\b(guard|handle|check|validate)\b[\s\S]{0,90}\b(null|undefined|missing|absent|partial|incomplete|unexpected shape|not set)\b|\bpotential(ly)? (null|undefined)\b|\bmay be (null|undefined)\b/i;

export function guardsImpossibleState(
  finding: { title: string; body: string },
  requiredFields: Set<string> | undefined,
): string | null {
  if (!requiredFields?.size) return null;
  const text = `${finding.title} ${finding.body.slice(0, 300)}`;
  if (!ASKS_FOR_A_GUARD.test(text)) return null;

  // A field is named either in backticks or as a bare dotted path; the claim is
  // about the last segment, since `account.lockRecord` is a claim
  // about `lockRecord`.
  const named = [
    ...[...text.matchAll(/`([A-Za-z_$][\w$.]*)`/g)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g)].map((m) => m[1] ?? ''),
  ].map((n) => n.split('.').pop() ?? '');

  for (const sym of named) {
    if (sym.length >= 4 && requiredFields.has(sym)) return sym;
  }
  return null;
}

/**
 * A second comment on code the reviewer already spoke about.
 *
 * A human reviewer does not return to the same four lines a round later with a
 * differently worded version of the note the author has just acted on. This
 * one did: it asked for a guard against an empty array, the author wrote it,
 * and the next round it asked for the opposite - having no memory of the first
 * ask, because memory recorded rejections and never recorded what was accepted.
 *
 * Suppressing by anchor rather than by wording is the point. The two comments
 * shared no phrasing and sat two lines apart, so every check that compares text
 * or buckets line numbers let the second one through.
 *
 * The window is deliberately tight. A fix can genuinely introduce a new defect
 * on the same lines, and that finding should still be raised; what this stops
 * is the reviewer circling the exact spot it has already been answered on.
 */
export function alreadySpokenHere(
  finding: { path: string; startLine: number; endLine: number },
  spokenAt: { path: string; line: number }[] | undefined,
  window = 4,
): boolean {
  if (!spokenAt?.length) return false;
  return spokenAt.some((s) =>
    s.path === finding.path
    && s.line >= finding.startLine - window
    && s.line <= finding.endLine + window);
}
