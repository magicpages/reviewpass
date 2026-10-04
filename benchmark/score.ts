/**
 * Scoring against the reference. Pure: no model calls, no files.
 *
 * A hit is a reference defect that at least one of a run's findings was placed
 * under - placed by mechanism, not by location, which is the whole difference
 * from a line-distance match. A run with three findings on one defect has one
 * hit. A false finding is one placed under a cause the reference ruled not a
 * defect.
 */
import type { BenchFinding, ReferenceEntry, Run, Severity } from './types.js';

export interface RunScore {
  run: number;
  hits: number;
  falseFindings: number;
  /** Findings no judge could place under any cause. */
  unplaced: number;
  findings: number;
  /** Files the model failed on, left unreviewed as production would leave them. */
  failedFiles: number;
  wallMs: number;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

export interface VerifierScore {
  /** Refuted findings that named a real defect: recall the verifier cost. */
  refutedReal: number;
  /** Refuted findings that named no defect: noise the verifier removed. */
  refutedNoise: number;
  refutedUnplaced: number;
}

export interface MethodScore {
  caseId: string;
  method: string;
  runs: RunScore[];
  /** Defects found by at least one run. */
  unionHits: number;
  defects: number;
  verifier: VerifierScore;
}

/** For each severity: how many defects a method found in k of its runs. */
export type Consistency = Record<Severity, number[]>;

type Placement = Map<string, string | null>;

export function scoreCase(ref: ReferenceEntry[], placed: Placement, runs: Run[]): MethodScore[] {
  const entry = new Map(ref.map((e) => [e.id, e]));
  const causeOf = (id: string) => { const c = placed.get(id); return c ? entry.get(c) : undefined; };
  const methods = [...new Set(runs.map((r) => r.method))];
  return methods.map((method) => {
    const mine = runs.filter((r) => r.method === method).sort((a, b) => a.run - b.run);
    const caseId = mine[0]!.caseId;
    const union = new Set<string>();
    const verifier: VerifierScore = { refutedReal: 0, refutedNoise: 0, refutedUnplaced: 0 };
    const scores = mine.map((r): RunScore => {
      const hit = new Set<string>();
      let falseFindings = 0, unplaced = 0;
      for (const f of r.findings) {
        const c = causeOf(f.id);
        if (!c) unplaced++;
        else if (c.defect) { hit.add(c.id); union.add(c.id); }
        else falseFindings++;
      }
      for (const f of r.refuted) {
        const c = causeOf(f.id);
        if (!c) verifier.refutedUnplaced++;
        else if (c.defect) verifier.refutedReal++;
        else verifier.refutedNoise++;
      }
      return { run: r.run, hits: hit.size, falseFindings, unplaced, findings: r.findings.length, failedFiles: r.failedFiles ?? 0,
        wallMs: r.wallMs, promptTokens: r.promptTokens, completionTokens: r.completionTokens,
        ...(r.error ? { error: r.error } : {}) };
    });
    return { caseId, method, runs: scores, unionHits: union.size,
      defects: ref.filter((e) => e.caseId === caseId && e.defect).length, verifier };
  });
}

/**
 * How reliably a method finds the same defects: for each reference defect, the
 * number of this method's runs that found it, tallied by severity. With three
 * runs the tally has four buckets - found in 0, 1, 2 or 3 of them. A defect found
 * in one or two is one a single run finds by chance.
 */
export function consistency(ref: ReferenceEntry[], placed: Placement, runs: Run[], method: string): Consistency {
  const mine = runs.filter((r) => r.method === method);
  const n = Math.max(0, ...mine.map((r) => r.run));
  // A case the method never ran on is not one where it missed every defect.
  const ran = new Set(mine.map((r) => r.caseId));
  const out: Consistency = { critical: [], high: [], medium: [], low: [] };
  for (const s of Object.keys(out) as Severity[]) out[s] = Array.from({ length: n + 1 }, () => 0);
  const byCause = new Map<string, Set<number>>();
  for (const r of mine) {
    for (const f of r.findings) {
      const c = placed.get(f.id);
      if (c) byCause.set(c, (byCause.get(c) ?? new Set()).add(r.run));
    }
  }
  for (const e of ref.filter((x) => x.defect && ran.has(x.caseId))) out[e.severity][byCause.get(e.id)?.size ?? 0]!++;
  return out;
}

/** A rule a method could apply to its findings before posting them. */
export interface FindingFilter {
  name: string;
  keep: (f: BenchFinding) => boolean;
}

export interface FilterScore {
  filter: string;
  method: string;
  /** Summed over every case and run. */
  hits: number;
  falseFindings: number;
  findings: number;
}

/**
 * What a method would have scored had it applied `filter` before posting: its
 * runs re-scored with the findings the filter drops removed. No model calls -
 * the reference already says which cause each finding names. Only methods whose
 * findings carry `meta` are scored, since the filters read it.
 */
export function scoreFilters(ref: ReferenceEntry[], placed: Placement, runs: Run[], filters: FindingFilter[]): FilterScore[] {
  const withMeta = runs.filter((r) => r.findings.some((f) => f.meta));
  const out: FilterScore[] = [];
  for (const filter of filters) {
    const filtered = withMeta.map((r) => ({ ...r, findings: r.findings.filter(filter.keep) }));
    const byMethod = new Map<string, FilterScore>();
    for (const caseId of new Set(filtered.map((r) => r.caseId))) {
      for (const s of scoreCase(ref, placed, filtered.filter((r) => r.caseId === caseId))) {
        const acc = byMethod.get(s.method) ?? { filter: filter.name, method: s.method, hits: 0, falseFindings: 0, findings: 0 };
        for (const r of s.runs) { acc.hits += r.hits; acc.falseFindings += r.falseFindings; acc.findings += r.findings; }
        byMethod.set(s.method, acc);
      }
    }
    out.push(...byMethod.values());
  }
  return out;
}

const rank: Record<string, number> = { trivial: 0, minor: 1, major: 2, critical: 3 };
const support = (f: BenchFinding) => f.meta?.samples?.length ?? 1;

/** The filters worth asking about first. Each reads only what reviewpass records. */
export const STANDARD_FILTERS: FindingFilter[] = [
  { name: 'all verified', keep: () => true },
  // Runs recorded before triage carry no tier; everything they kept was posted.
  { name: 'posted inline', keep: (f) => (f.meta?.tier ?? 'inline') === 'inline' },
  { name: 'inline or listed', keep: (f) => f.meta?.tier !== 'dropped' },
  { name: 'raised by 2+ samples', keep: (f) => support(f) >= 2 },
  { name: '2+ samples, or major and up', keep: (f) => support(f) >= 2 || (rank[f.meta?.severity ?? ''] ?? 0) >= 2 },
  { name: 'no trivial', keep: (f) => f.meta?.severity !== 'trivial' },
  { name: 'no maintainability', keep: (f) => f.meta?.category !== 'maintainability' },
  { name: 'importance 5+', keep: (f) => (f.meta?.importance ?? 10) >= 5 },
  { name: 'importance 7+', keep: (f) => (f.meta?.importance ?? 10) >= 7 },
  { name: 'confidence 0.8+', keep: (f) => (f.meta?.confidence ?? 1) >= 0.8 },
];
