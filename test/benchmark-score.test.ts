/**
 * The benchmark's scoring rules. Each is a decision about what counts, and each
 * is easy to get subtly wrong in a way that flatters one method.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consistency, scoreCase } from '../benchmark/score.js';
import type { BenchFinding, ReferenceEntry, Run } from '../benchmark/types.js';

const entry = (id: string, defect: boolean, severity: ReferenceEntry['severity'] = 'medium'): ReferenceEntry => ({
  id, caseId: 'c', path: 'a.ts', members: [], mechanism: id, defect, severity, verdicts: [], settledBy: 'agreement',
});
const f = (id: string): BenchFinding => ({ id, path: 'a.ts', startLine: 1, endLine: 1, title: id, body: '' });
const run = (n: number, findings: string[], refuted: string[] = [], method = 'm'): Run => ({
  caseId: 'c', method, run: n, findings: findings.map(f), refuted: refuted.map(f),
  wallMs: 1000, promptTokens: 10, completionTokens: 5,
});

const ref = [entry('bug', true, 'high'), entry('bug2', true, 'low'), entry('noise', false)];

test('several findings on one defect in one run are one hit, not several', () => {
  const placed = new Map([['x1', 'bug'], ['x2', 'bug'], ['x3', 'bug']]);
  const [s] = scoreCase(ref, placed, [run(1, ['x1', 'x2', 'x3'])]);
  assert.equal(s!.runs[0]!.hits, 1);
});

test('a finding placed under a non-defect is a false finding, not a hit', () => {
  const placed = new Map([['x1', 'bug'], ['x2', 'noise']]);
  const [s] = scoreCase(ref, placed, [run(1, ['x1', 'x2'])]);
  assert.equal(s!.runs[0]!.hits, 1);
  assert.equal(s!.runs[0]!.falseFindings, 1);
});

test('a finding no judge could place is neither a hit nor a false finding', () => {
  const placed = new Map<string, string | null>([['x1', null]]);
  const [s] = scoreCase(ref, placed, [run(1, ['x1'])]);
  assert.deepEqual([s!.runs[0]!.hits, s!.runs[0]!.falseFindings, s!.runs[0]!.unplaced], [0, 0, 1]);
});

test('the union counts each defect once across runs', () => {
  const placed = new Map([['a', 'bug'], ['b', 'bug'], ['c', 'bug2']]);
  const [s] = scoreCase(ref, placed, [run(1, ['a']), run(2, ['b']), run(3, ['c'])]);
  assert.deepEqual(s!.runs.map((r) => r.hits), [1, 1, 1]);
  assert.equal(s!.unionHits, 2);
  assert.equal(s!.defects, 2);
});

test('the verifier is scored on what it removed: real defects lost versus noise removed', () => {
  const placed = new Map([['kept', 'bug'], ['r1', 'bug2'], ['r2', 'noise'], ['r3', 'noise']]);
  const [s] = scoreCase(ref, placed, [run(1, ['kept'], ['r1', 'r2', 'r3'])]);
  assert.deepEqual(s!.verifier, { refutedReal: 1, refutedNoise: 2, refutedUnplaced: 0 });
});

test('consistency tallies each defect by how many runs found it, per severity', () => {
  const placed = new Map([['a', 'bug'], ['b', 'bug']]);
  const c = consistency(ref, placed, [run(1, ['a']), run(2, ['b']), run(3, [])], 'm');
  // `bug` (high) found in runs 1 and 2; `bug2` (low) never; `noise` is not a defect.
  assert.deepEqual(c.high, [0, 0, 1, 0]);
  assert.deepEqual(c.low, [1, 0, 0, 0]);
  assert.deepEqual(c.medium, [0, 0, 0, 0]);
});

test('methods are scored separately', () => {
  const placed = new Map([['a', 'bug'], ['b', 'noise']]);
  const scores = scoreCase(ref, placed, [run(1, ['a'], [], 'reviewpass'), run(1, ['b'], [], 'raw')]);
  const by = Object.fromEntries(scores.map((s) => [s.method, s.runs[0]!]));
  assert.deepEqual([by.reviewpass!.hits, by.reviewpass!.falseFindings], [1, 0]);
  assert.deepEqual([by.raw!.hits, by.raw!.falseFindings], [0, 1]);
});

test('files the model failed on are carried into the score, not hidden', () => {
  const r = { ...run(1, ['a']), failedFiles: 2 };
  const [s] = scoreCase(ref, new Map([['a', 'bug']]), [r]);
  assert.equal(s!.runs[0]!.failedFiles, 2);
});

test('consistency ignores defects in cases the method never ran on', () => {
  const other = { ...entry('elsewhere', true, 'high'), caseId: 'd' };
  const c = consistency([...ref, other], new Map([['a', 'bug']]), [run(1, ['a'])], 'm');
  // `elsewhere` is in case d, which method m skipped: not a defect it missed.
  assert.deepEqual(c.high, [0, 1]);
});

test('method keys stay as they were for settings without the newer fields', async () => {
  const { methodKey } = await import('../benchmark/runs.js');
  const m = { endpoint: 'e', name: 'model-a', effort: 'low' as const, maxTokens: 32768 };
  assert.equal(methodKey('reviewpass', m), 'reviewpass@model-a@low@32768');
  assert.equal(methodKey('raw', { ...m, effort: undefined }), 'raw@model-a@default@32768');
  assert.equal(methodKey('reviewpass', { ...m, verifyName: 'model-b', label: 'meta' }), 'reviewpass@model-a@low@32768+verify=model-b#meta');
});

test('review settings are part of the method key, in a fixed order', async () => {
  const { methodKey } = await import('../benchmark/runs.js');
  const m = { endpoint: 'e', name: 'model-a', effort: 'low' as const, maxTokens: 32768 };
  const a = methodKey('reviewpass', { ...m, review: { findSamples: 6, verify: true } });
  const b = methodKey('reviewpass', { ...m, review: { verify: true, findSamples: 6 } });
  assert.equal(a, 'reviewpass@model-a@low@32768+findSamples=6+verify=true');
  assert.equal(a, b, 'the order the settings are written in must not make a second method');
});

test('a filter is scored as if the method had applied it before posting', async () => {
  const { scoreFilters, STANDARD_FILTERS } = await import('../benchmark/score.js');
  const withMeta = (id: string, samples: number[], severity = 'minor'): BenchFinding => ({ ...f(id), meta: { samples, severity } });
  const runs: Run[] = [{
    caseId: 'c', method: 'm', run: 1, refuted: [], wallMs: 0, promptTokens: 0, completionTokens: 0,
    findings: [withMeta('agreed', [0, 2]), withMeta('lone', [1]), withMeta('loneNoise', [3]), withMeta('loneMajor', [1], 'major')],
  }, { ...run(1, ['x'], [], 'no-meta') }];
  const placed = new Map([['agreed', 'bug'], ['lone', 'bug2'], ['loneNoise', 'noise'], ['loneMajor', 'noise'], ['x', 'bug']]);
  const scores = scoreFilters(ref, placed, runs, STANDARD_FILTERS);
  const by = (name: string) => scores.find((s) => s.filter === name)!;
  assert.ok(scores.every((s) => s.method === 'm'), 'a method without meta cannot be filtered, so it is not scored');
  assert.deepEqual([by('all verified').hits, by('all verified').falseFindings], [2, 2]);
  // Requiring agreement drops the lone real defect and both lone noise findings.
  assert.deepEqual([by('raised by 2+ samples').hits, by('raised by 2+ samples').falseFindings], [1, 0]);
  // Letting major findings through regardless keeps the lone major noise.
  assert.deepEqual([by('2+ samples, or major and up').hits, by('2+ samples, or major and up').falseFindings], [1, 1]);
});

test('tier filters score what the author is shown; runs without tiers count as posted inline', async () => {
  const { scoreFilters, STANDARD_FILTERS } = await import('../benchmark/score.js');
  const tiered = (id: string, tier?: 'inline' | 'listed' | 'dropped'): BenchFinding => ({ ...f(id), meta: { severity: 'minor', ...(tier ? { tier } : {}) } });
  const runs: Run[] = [{
    caseId: 'c', method: 'm', run: 1, refuted: [], wallMs: 0, promptTokens: 0, completionTokens: 0,
    findings: [tiered('agreed', 'inline'), tiered('lone', 'listed'), tiered('loneNoise', 'dropped'), tiered('loneMajor')],
  }];
  const placed = new Map([['agreed', 'bug'], ['lone', 'bug2'], ['loneNoise', 'noise'], ['loneMajor', 'noise']]);
  const scores = scoreFilters(ref, placed, runs, STANDARD_FILTERS);
  const by = (name: string) => scores.find((s) => s.filter === name)!;
  assert.equal(by('all verified').findings, 4);
  assert.equal(by('inline or listed').findings, 3);
  assert.equal(by('posted inline').findings, 2);
});
