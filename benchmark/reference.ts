/**
 * Build the reference: group every finding by cause, judge each cause blind,
 * then have a second judge re-assign the findings to causes independently.
 *
 * Three passes, one per file, because a file's code and diff are what a judge
 * needs and they are the same for every finding in it:
 *
 *   group    one judge collects findings that name the same mechanism
 *   judge    two judges independently rule each cause a defect or not, and how
 *            severe; a third settles the causes they disagree on
 *   assign   a second judge places each finding under a cause without seeing
 *            the first grouping; a third settles the findings they place differently
 *
 * Blind throughout: prompts carry opaque labels (F1, C1) and never the method,
 * the run or the model that produced a finding.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ask, isObject, type Judge, type Spend } from './judges.js';
import type { BenchFinding, Case, Cause, ReferenceEntry, Severity, Verdict } from './types.js';

export interface Judges { first: Judge; second: Judge; tiebreak: Judge }

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * The label a judge meant. Judges echo the line they were shown instead of its
 * label - `"C1: The retry loop never backs off..."`, or the description alone with no
 * label at all - and an exact-match check then rejects a reply whose rulings are
 * all there and all sound, and pays for it four times over. The per-call enum in
 * each schema prevents this where the endpoint enforces the schema; this reads
 * the label back where it does not. `byText` maps each description shown to its
 * label.
 */
export function label(s: string, byText?: Map<string, string>): string {
  const m = /^\s*([FC]\d+)\b/.exec(s);
  if (m) return m[1]!;
  const t = s.trim();
  if (t.toLowerCase() === 'none') return 'none';
  return byText?.get(t) ?? s;
}

type Resolve = (s: string) => string;
const labels = (prefix: 'F' | 'C', n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** The diff and the file after the change: what every judge of this file reads. */
function fileContext(c: Case, path: string): string {
  const diff = execFileSync('git', ['-C', c.workspace, 'diff', '--no-renames', `${c.base}...${c.head}`, '--', path],
    { encoding: 'utf8', maxBuffer: 1e9 });
  const abs = join(c.workspace, path);
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const body = !text ? '(file not present after the change)'
    : text.length <= 60_000 ? text : `${text.slice(0, 60_000)}\n... (truncated at 60,000 characters)`;
  return `# Pull request: ${c.title}\n\n${c.body || '(no description)'}\n\n## Diff of ${path}\n\`\`\`diff\n${diff || '(no diff: the finding names a file the change did not touch)'}\n\`\`\`\n\n## ${path} after the change\n\`\`\`\n${body}\n\`\`\``;
}

const byPath = <T extends { path: string }>(xs: T[]) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(x.path, [...(m.get(x.path) ?? []), x]);
  return m;
};

export const findingText = (label: string, f: BenchFinding) =>
  `${label} (lines ${f.startLine}-${f.endLine}): ${f.title}\n${f.body}`;

// ---------------------------------------------------------------- group

interface Groups { groups: { mechanism: string; members: string[] }[] }
/**
 * Every finding at most once, and at least one grouped. A finding the judge left
 * out is not lost: `groupFile` groups the leftovers in a call of their own. A
 * judge at temperature 0 that skips one finding of eighty skips it on every
 * attempt, so demanding all of them in one reply stopped a whole reference.
 */
const isGroups = (fl: string[]) => (v: unknown): v is Groups => {
  if (!isObject(v) || !Array.isArray(v.groups)) return false;
  const seen: string[] = [];
  for (const g of v.groups) {
    if (!isObject(g) || typeof g.mechanism !== 'string' || !Array.isArray(g.members) || !g.members.length) return false;
    for (const m of g.members) { if (typeof m !== 'string' || !fl.includes(label(m))) return false; seen.push(label(m)); }
  }
  return seen.length > 0 && new Set(seen).size === seen.length;
};
const groupsSchema = (fl: string[]) => ({
  type: 'object', additionalProperties: false, required: ['groups'],
  properties: { groups: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['mechanism', 'members'],
    properties: { mechanism: { type: 'string' }, members: { type: 'array', items: { type: 'string', enum: fl } } } } } },
});

export async function groupCauses(c: Case, findings: BenchFinding[], judge: Judge, spend: Spend): Promise<Cause[]> {
  const causes: Cause[] = [];
  for (const [path, fs] of byPath(findings)) {
    (await groupFile(c, path, fs, judge, spend)).forEach((g, gi) => causes.push({
      id: `${c.id}/${path}#${gi}`, caseId: c.id, path, mechanism: g.mechanism, members: g.members.map((f) => f.id),
    }));
  }
  return causes;
}

async function groupFile(c: Case, path: string, fs: BenchFinding[], judge: Judge, spend: Spend,
): Promise<{ mechanism: string; members: BenchFinding[] }[]> {
  if (fs.length === 1) return [{ mechanism: `${fs[0]!.title} ${fs[0]!.body}`.trim(), members: fs }];
  const fl = labels('F', fs.length);
  const v = await ask(judge,
    'You group code review findings by the defect they describe. Two findings belong together only if they name the same '
    + 'mechanism - the same thing going wrong for the same reason. Sharing a location is not enough, and neither is a similar '
    + 'topic. Put every finding in exactly one group; a finding unlike all others is a group of one. For each group, state '
    + 'the mechanism in one or two sentences.',
    `${fileContext(c, path)}\n\n## Findings\n\n${fs.map((f, i) => findingText(fl[i]!, f)).join('\n\n')}`,
    groupsSchema(fl), isGroups(fl), spend);
  const groups = v.groups.map((g) => ({ mechanism: g.mechanism, members: g.members.map((m) => fs[fl.indexOf(label(m))]!) }));
  const grouped = new Set(groups.flatMap((g) => g.members));
  const left = fs.filter((f) => !grouped.has(f));
  return left.length ? [...groups, ...await groupFile(c, path, left, judge, spend)] : groups;
}

// ---------------------------------------------------------------- judge

interface Rulings { rulings: { cause: string; defect: boolean; severity: Severity; reason: string }[] }
const isRulings = (cl: string[], lab: Resolve) => (v: unknown): v is Rulings =>
  isObject(v) && Array.isArray(v.rulings) && v.rulings.length === cl.length
  && v.rulings.every((r) => isObject(r) && typeof r.cause === 'string' && cl.includes(lab(r.cause))
    && typeof r.defect === 'boolean' && SEVERITIES.includes(r.severity as Severity) && typeof r.reason === 'string')
  && new Set(v.rulings.map((r) => lab((r as { cause: string }).cause))).size === cl.length;
const rulingsSchema = (cl: string[]) => ({
  type: 'object', additionalProperties: false, required: ['rulings'],
  properties: { rulings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['cause', 'defect', 'severity', 'reason'],
    properties: { cause: { type: 'string', enum: cl }, defect: { type: 'boolean' },
      severity: { type: 'string', enum: SEVERITIES }, reason: { type: 'string' } } } } },
});
const JUDGE_SYSTEM = 'You decide, against the code, whether each candidate describes a real defect in this change. A defect is '
  + 'behaviour the code actually gets wrong - a bug, a vulnerability, lost data, a broken contract - that you can confirm from the '
  + 'code shown. Style preferences, speculation the code does not support, and suggestions without a defect behind them are not '
  + 'defects. Judge only from the code; do not assume the candidate is right. Severity, for defects: critical = security or data '
  + 'loss in normal use; high = wrong behaviour users will hit; medium = wrong behaviour in edge cases; low = minor. For a '
  + 'non-defect, give the severity it would have had. Rule on every cause exactly once.';

async function rule(c: Case, path: string, cs: Cause[], texts: Map<string, BenchFinding>, judge: Judge, spend: Spend) {
  const cl = labels('C', cs.length);
  const lab: Resolve = (s) => label(s, new Map(cs.map((x, i) => [x.mechanism.trim(), cl[i]!])));
  const list = cs.map((x, i) => `${cl[i]}: ${x.mechanism}\n  raised as:\n${x.members
    .map((m) => { const f = texts.get(m)!; return `  - lines ${f.startLine}-${f.endLine}: ${f.title}`; }).join('\n')}`).join('\n\n');
  const v = await ask(judge, JUDGE_SYSTEM, `${fileContext(c, path)}\n\n## Causes\n\n${list}`, rulingsSchema(cl), isRulings(cl, lab), spend);
  return new Map(v.rulings.map((r) => [cs[cl.indexOf(lab(r.cause))]!.id, { judge: judge.name, defect: r.defect, severity: r.severity, reason: r.reason } satisfies Verdict]));
}

export async function judgeCauses(c: Case, causes: Cause[], texts: Map<string, BenchFinding>, j: Judges, spend: Spend): Promise<ReferenceEntry[]> {
  const out: ReferenceEntry[] = [];
  for (const [path, cs] of byPath(causes)) {
    const [a, b] = await Promise.all([rule(c, path, cs, texts, j.first, spend), rule(c, path, cs, texts, j.second, spend)]);
    // Disagreeing on whether it is a defect, or on how severe a defect is, goes to the tiebreak.
    const split = cs.filter((x) => a.get(x.id)!.defect !== b.get(x.id)!.defect
      || (a.get(x.id)!.defect && a.get(x.id)!.severity !== b.get(x.id)!.severity));
    const t = split.length ? await rule(c, path, split, texts, j.tiebreak, spend) : new Map<string, Verdict>();
    for (const x of cs) {
      const va = a.get(x.id)!, vb = b.get(x.id)!, vt = t.get(x.id);
      const settled = vt ?? va;
      out.push({ ...x, defect: settled.defect, severity: settled.severity,
        verdicts: vt ? [va, vb, vt] : [va, vb], settledBy: vt ? 'tiebreak' : 'agreement' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- assign

interface Placements { placements: { finding: string; cause: string }[] }
const isPlacements = (fl: string[], cl: string[], lab: Resolve) => (v: unknown): v is Placements =>
  isObject(v) && Array.isArray(v.placements) && v.placements.length === fl.length
  && v.placements.every((p) => isObject(p) && typeof p.finding === 'string' && fl.includes(label(p.finding))
    && typeof p.cause === 'string' && (cl.includes(lab(p.cause)) || lab(p.cause) === 'none'))
  && new Set(v.placements.map((p) => label((p as { finding: string }).finding))).size === fl.length;
const placementsSchema = (fl: string[], cl: string[]) => ({
  type: 'object', additionalProperties: false, required: ['placements'],
  properties: { placements: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['finding', 'cause'],
    properties: { finding: { type: 'string', enum: fl }, cause: { type: 'string', enum: [...cl, 'none'] } } } } },
});

/**
 * At most this many findings per placement call. A judge reasons in proportion to
 * the findings it must place: 159 in one call ran a judge into its provider's
 * output ceiling on reasoning alone, every attempt. Each batch still sees the
 * whole file and every cause.
 */
export const PLACE_BATCH = 40;

export function batches<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function place(c: Case, path: string, fs: BenchFinding[], cs: ReferenceEntry[], judge: Judge, spend: Spend) {
  const out = new Map<string, string | null>();
  for (const batch of batches(fs, PLACE_BATCH)) {
    for (const [k, v] of await placeHalving(c, path, batch, cs, judge, spend)) out.set(k, v);
  }
  return out;
}

/**
 * A batch the judge cannot answer whole is placed in halves. At temperature 0 a
 * judge repeats its mistake: one placed 25 of 26 findings on every attempt and
 * stopped an extension. Half the batch is a different question. A single
 * finding it cannot place still fails, loudly.
 */
async function placeHalving(c: Case, path: string, fs: BenchFinding[], cs: ReferenceEntry[], judge: Judge, spend: Spend,
): Promise<Map<string, string | null>> {
  try {
    return await placeBatch(c, path, fs, cs, judge, spend);
  } catch (e) {
    if (fs.length < 2 || !/no usable verdict/.test(String(e))) throw e;
    const mid = Math.ceil(fs.length / 2);
    return new Map([
      ...await placeHalving(c, path, fs.slice(0, mid), cs, judge, spend),
      ...await placeHalving(c, path, fs.slice(mid), cs, judge, spend),
    ]);
  }
}

async function placeBatch(c: Case, path: string, fs: BenchFinding[], cs: ReferenceEntry[], judge: Judge, spend: Spend) {
  const fl = labels('F', fs.length);
  const cl = labels('C', cs.length);
  const lab: Resolve = (s) => label(s, new Map(cs.map((x, i) => [x.mechanism.trim(), cl[i]!])));
  const v = await ask(judge,
    'Place each finding under the cause whose mechanism it names. A finding names a cause only if it describes the same thing '
    + 'going wrong for the same reason; the same location alone does not count. Use "none" when it names none of them. Place '
    + 'every finding exactly once.',
    `${fileContext(c, path)}\n\n## Causes\n\n${cs.map((x, i) => `${cl[i]}: ${x.mechanism}`).join('\n')}\n\n## Findings\n\n${fs
      .map((f, i) => findingText(fl[i]!, f)).join('\n\n')}`,
    placementsSchema(fl, cl), isPlacements(fl, cl, lab), spend);
  return new Map(v.placements.map((p) => [fs[fl.indexOf(label(p.finding))]!.id,
    lab(p.cause) === 'none' ? null : cs[cl.indexOf(lab(p.cause))]!.id]));
}

/**
 * The finally agreed cause for each finding, or null when a finding names none.
 * The grouping is one judge's placement; a second places blind; disagreements
 * go to the tiebreak, whose answer stands.
 */
export async function assignFindings(c: Case, findings: BenchFinding[], ref: ReferenceEntry[], j: Judges, spend: Spend,
  firstPlacement?: Map<string, string | null>) {
  // The first placement is the grouping, unless the findings were never grouped:
  // then it is the first judge's own blind placement.
  const first = new Map<string, string | null>(firstPlacement ?? []);
  if (!firstPlacement) for (const e of ref) for (const m of e.members) first.set(m, e.id);
  const final = new Map<string, string | null>();
  let disputed = 0;
  for (const [path, fs] of byPath(findings)) {
    const cs = ref.filter((e) => e.path === path);
    // No causes to choose from: nothing a judge could say but "none".
    const second = cs.length ? await place(c, path, fs, cs, j.second, spend) : new Map(fs.map((f) => [f.id, null]));
    const split = fs.filter((f) => (first.get(f.id) ?? null) !== second.get(f.id));
    disputed += split.length;
    const t = split.length ? await place(c, path, split, cs, j.tiebreak, spend) : new Map<string, string | null>();
    for (const f of fs) final.set(f.id, t.has(f.id) ? t.get(f.id)! : (first.get(f.id) ?? null));
  }
  return { final, disputed };
}

// ---------------------------------------------------------------- extend

/** Findings in the pool that the reference has not placed yet: what new runs added. */
export function unplacedFindings(pool: BenchFinding[], placed: Iterable<[string, string | null]>): BenchFinding[] {
  const done = new Set([...placed].map(([id]) => id));
  return pool.filter((f) => !done.has(f.id));
}

/**
 * New causes' ids made distinct from the reference's: grouping numbers causes per
 * file from `#0`, which the reference already uses.
 */
export function renumberCauses(entries: ReferenceEntry[], placed: Map<string, string | null>, tag: string) {
  const id = (old: string) => `${old}+${tag}`;
  return {
    entries: entries.map((e) => ({ ...e, id: id(e.id) })),
    placed: new Map([...placed].map(([f, cause]) => [f, cause === null ? null : id(cause)])),
  };
}

/**
 * Both judges place each finding blind under the causes already judged, and the
 * tiebreak settles where they differ. `null` is a finding no cause fits.
 */
export async function placeIntoReference(c: Case, findings: BenchFinding[], ref: ReferenceEntry[], j: Judges, spend: Spend) {
  const firstPlacement = new Map<string, string | null>();
  for (const [path, fs] of byPath(findings)) {
    const cs = ref.filter((e) => e.path === path);
    for (const [f, cause] of (cs.length ? await place(c, path, fs, cs, j.first, spend) : new Map(fs.map((x) => [x.id, null])))) {
      firstPlacement.set(f, cause);
    }
  }
  return assignFindings(c, findings, ref, j, spend, firstPlacement);
}

/**
 * Place findings from new runs into an existing reference without judging it
 * again. Both judges place each new finding blind under the causes already
 * there, and the tiebreak settles where they differ - the same two-judge rule
 * the reference was built with. Findings neither can place name a cause the
 * reference lacks: those go through grouping, rulings and assignment as new
 * causes. `tag` keeps the new causes' ids apart from the old ones.
 */
export async function extendReference(c: Case, fresh: BenchFinding[], ref: ReferenceEntry[], j: Judges, spend: Spend,
  tag: string) {
  const known = await placeIntoReference(c, fresh, ref, j, spend);
  const leftover = fresh.filter((f) => known.final.get(f.id) === null);
  if (!leftover.length) return { entries: [] as ReferenceEntry[], placed: known.final, disputed: known.disputed };

  const causes = await groupCauses(c, leftover, j.first, spend);
  const entries = await judgeCauses(c, causes, new Map(leftover.map((f) => [f.id, f])), j, spend);
  const added = await assignFindings(c, leftover, entries, j, spend);
  const renumbered = renumberCauses(entries, added.final, tag);
  const placed = new Map(known.final);
  for (const [f, cause] of renumbered.placed) placed.set(f, cause);
  return { entries: renumbered.entries, placed, disputed: known.disputed + added.disputed };
}
