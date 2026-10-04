/**
 * How far a second panel of judges agrees with the panel a reference was built
 * with. Pure: no model calls, no files.
 *
 * A reference is only as good as its judges, and the judges a benchmark can
 * afford are not always the ones it would choose - a panel from the family
 * under test grades its own lineage. Before such a panel extends a reference,
 * it re-rules the causes the first panel ruled and re-places findings the first
 * panel placed; where it disagrees, and whether the disagreement would change
 * which method wins, is the measurement.
 */
import type { ReferenceEntry, Run } from './types.js';
import { scoreCase } from './score.js';

export interface RulingAgreement {
  causes: number;
  /** Both panels: a defect. */
  bothDefect: number;
  /** Both panels: not a defect. */
  bothNot: number;
  /** The reference says defect, the new panel does not. */
  referenceOnly: number;
  /** The new panel says defect, the reference does not. */
  panelOnly: number;
  /** Among causes both call a defect, how many got the same severity. */
  sameSeverity: number;
}

export function compareRulings(reference: ReferenceEntry[], panel: ReferenceEntry[]): RulingAgreement {
  const byId = new Map(panel.map((e) => [e.id, e]));
  const out: RulingAgreement = { causes: 0, bothDefect: 0, bothNot: 0, referenceOnly: 0, panelOnly: 0, sameSeverity: 0 };
  for (const r of reference) {
    const p = byId.get(r.id);
    if (!p) continue;
    out.causes++;
    if (r.defect && p.defect) { out.bothDefect++; if (r.severity === p.severity) out.sameSeverity++; }
    else if (!r.defect && !p.defect) out.bothNot++;
    else if (r.defect) out.referenceOnly++;
    else out.panelOnly++;
  }
  return out;
}

export interface PlacementAgreement {
  findings: number;
  same: number;
  /** Placed under different causes. */
  moved: number;
  /** Placed by one panel, left without a cause by the other. */
  unplacedByOne: number;
}

export function comparePlacements(
  reference: Map<string, string | null>, panel: Map<string, string | null>,
): PlacementAgreement {
  const out: PlacementAgreement = { findings: 0, same: 0, moved: 0, unplacedByOne: 0 };
  for (const [id, p] of panel) {
    if (!reference.has(id)) continue;
    const r = reference.get(id) ?? null;
    out.findings++;
    if (r === p) out.same++;
    else if (r === null || p === null) out.unplacedByOne++;
    else out.moved++;
  }
  return out;
}

/**
 * The reference with the panel's rulings in place of its own: same causes,
 * same placements, so any change in a method's score is the rulings alone.
 */
export function withRulings(reference: ReferenceEntry[], panel: ReferenceEntry[]): ReferenceEntry[] {
  const byId = new Map(panel.map((e) => [e.id, e]));
  return reference.map((e) => {
    const p = byId.get(e.id);
    return p ? { ...e, defect: p.defect, severity: p.severity, verdicts: p.verdicts, settledBy: p.settledBy } : e;
  });
}

/** Mean hits and false findings per run of every method, under one reference. */
export function meanScores(ref: ReferenceEntry[], placed: Map<string, string | null>, runs: Run[]) {
  return new Map(scoreCase(ref, placed, runs).map((m) => {
    const ok = m.runs.filter((r) => !r.error);
    const mean = (k: 'hits' | 'falseFindings') => ok.reduce((s, r) => s + r[k], 0) / Math.max(1, ok.length);
    return [m.method, { hits: mean('hits'), falseFindings: mean('falseFindings') }];
  }));
}
