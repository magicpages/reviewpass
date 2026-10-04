/**
 * Calibration compares a second panel of judges with the one a reference was
 * built with: its rulings, its placements, and what its rulings would do to a
 * method's score.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRulings, comparePlacements, withRulings, meanScores } from '../benchmark/calibrate.js';
import type { BenchFinding, ReferenceEntry, Run, Severity } from '../benchmark/types.js';

const entry = (id: string, defect: boolean, severity: Severity = 'medium'): ReferenceEntry => ({
  id, caseId: 'c', path: 'a.ts', members: [], mechanism: id, defect, severity, verdicts: [], settledBy: 'agreement',
});
const f = (id: string): BenchFinding => ({ id, path: 'a.ts', startLine: 1, endLine: 1, title: id, body: id });

test('rulings are compared cause by cause, severity only where both call it a defect', () => {
  const reference = [entry('a', true, 'high'), entry('b', true), entry('c', false), entry('d', false), entry('e', true)];
  const panel = [entry('a', true, 'high'), entry('b', false), entry('c', false), entry('d', true), entry('e', true, 'low')];
  assert.deepEqual(compareRulings(reference, panel),
    { causes: 5, bothDefect: 2, bothNot: 1, referenceOnly: 1, panelOnly: 1, sameSeverity: 1 });
});

test('a cause the panel did not rule is left out, not counted as a disagreement', () => {
  assert.equal(compareRulings([entry('a', true), entry('b', true)], [entry('a', true)]).causes, 1);
});

test('placements are the same, moved, or placed by one panel only', () => {
  const reference = new Map<string, string | null>([['f1', 'a'], ['f2', 'a'], ['f3', null], ['f4', 'b']]);
  const panel = new Map<string, string | null>([['f1', 'a'], ['f2', 'b'], ['f3', 'a'], ['f4', 'b'], ['f9', 'a']]);
  assert.deepEqual(comparePlacements(reference, panel), { findings: 4, same: 2, moved: 1, unplacedByOne: 1 });
});

test('the panel\'s rulings change a method\'s score; causes and placements stay', () => {
  const reference = [entry('a', true), entry('b', false)];
  const panel = [entry('a', false), entry('b', true)];
  const placed = new Map<string, string | null>([['f1', 'a'], ['f2', 'b']]);
  const runs: Run[] = [{ caseId: 'c', method: 'm', run: 1, findings: [f('f1'), f('f2')], refuted: [], wallMs: 0, promptTokens: 0, completionTokens: 0 }];
  const merged = withRulings(reference, panel);
  assert.deepEqual(merged.map((e) => [e.id, e.defect, e.mechanism]), [['a', false, 'a'], ['b', true, 'b']]);
  assert.deepEqual(meanScores(reference, placed, runs).get('m'), { hits: 1, falseFindings: 1 });
  assert.deepEqual(meanScores(merged, placed, runs).get('m'), { hits: 1, falseFindings: 1 });
  const onlyA = { ...runs[0]!, findings: [f('f1')] };
  assert.deepEqual(meanScores(merged, placed, [onlyA]).get('m'), { hits: 0, falseFindings: 1 });
});
