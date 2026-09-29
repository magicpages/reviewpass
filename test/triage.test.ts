/**
 * Which findings are posted inline, listed in the review body, or not posted.
 * Every rule here trades a real finding against noise, so each is pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { triageFindings } from '../src/review/triage.js';
import type { Finding } from '../src/types.js';

const review = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-'))).review;
const f = (title: string, over: Partial<Finding> = {}): Finding => ({
  path: 'a.ts', startLine: 1, endLine: 1, severity: 'minor', category: 'correctness', title, body: 'b', importance: 5, ...over,
});
const titles = (xs: Finding[]) => xs.map((x) => x.title);

test('trivial findings are not posted', () => {
  const t = triageFindings([f('nit', { severity: 'trivial' }), f('real')], review, false);
  assert.deepEqual([titles(t.inline), titles(t.dropped)], [['real'], ['nit']]);
});

test('maintainability is inline, listed or dropped by the importance the verifier gave it', () => {
  const t = triageFindings([
    f('stale comment', { category: 'maintainability', importance: 6 }),
    f('edge', { category: 'maintainability', importance: 4 }),
    f('taste', { category: 'maintainability', importance: 3 }),
  ], review, false);
  assert.deepEqual([titles(t.inline), titles(t.listed), titles(t.dropped)], [['stale comment'], ['edge'], ['taste']]);
});

test('other categories are never gated on importance', () => {
  const t = triageFindings([f('low-rated bug', { importance: 2 })], review, false);
  assert.deepEqual(titles(t.inline), ['low-rated bug']);
});

test('a finding the verifier could not rate is not hidden for it', () => {
  const t = triageFindings([f('unverified', { category: 'maintainability', importance: undefined })], review, false);
  assert.deepEqual(titles(t.inline), ['unverified']);
});

test('past the cap a finding is listed, not dropped; a critical one stays inline', () => {
  const many = Array.from({ length: 17 }, (_, i) => f(`f${i}`));
  const t = triageFindings([...many, f('crit', { severity: 'critical' })], review, false);
  assert.equal(t.inline.length, 16, '15 by the cap, plus the critical one');
  assert.ok(titles(t.inline).includes('crit'));
  assert.deepEqual(titles(t.listed), ['f15', 'f16']);
  assert.equal(t.dropped.length, 0);
});

test('a follow-up round raises only what matters, three at most', () => {
  const t = triageFindings([
    f('major a', { severity: 'major' }), f('major b', { severity: 'major' }),
    f('important minor', { importance: 8 }), f('major c', { severity: 'major' }),
    f('ordinary minor', { importance: 5 }),
  ], review, true);
  assert.deepEqual(titles(t.inline), ['major a', 'major b', 'important minor']);
  assert.deepEqual(titles(t.listed), ['major c', 'ordinary minor']);
});
