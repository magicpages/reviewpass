/**
 * Judges echo the labelled line instead of the label. Reading the label out of
 * it is the difference between a usable ruling and four paid-for rejections.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batches, findingText, label, PLACE_BATCH } from '../benchmark/reference.js';

test('the label is read from the start of an echoed line', () => {
  assert.equal(label('C1: The retry loop never backs off, so a failing upstream is hammered.'), 'C1');
  assert.equal(label('F12 (lines 40-41): Guard the empty list'), 'F12');
  assert.equal(label('C12'), 'C12');
  assert.equal(label('  C3 - the retry loop'), 'C3');
});

test('"none" is recognised in any case; anything else is left alone to fail the check', () => {
  assert.equal(label('None'), 'none');
  assert.equal(label(' none '), 'none');
  assert.equal(label('Cause 1'), 'Cause 1');
  assert.equal(label('C'), 'C');
});

test('a description echoed without its label is mapped back to the label it was shown with', () => {
  const byText = new Map([['The retry loop never backs off.', 'C2']]);
  assert.equal(label('The retry loop never backs off.', byText), 'C2');
  assert.equal(label('  The retry loop never backs off.  ', byText), 'C2');
  assert.equal(label('Some other description', byText), 'Some other description');
});

test('placement batches cover every finding once, in order, none over the limit', () => {
  const xs = Array.from({ length: 159 }, (_, i) => i);
  const bs = batches(xs, PLACE_BATCH);
  assert.deepEqual(bs.map((b) => b.length), [40, 40, 40, 39]);
  assert.deepEqual(bs.flat(), xs);
  assert.deepEqual(batches([1, 2], PLACE_BATCH), [[1, 2]], 'a small file is one call, the same prompt as before');
  assert.deepEqual(batches([], PLACE_BATCH), []);
});

test('a judge never sees what the method knew about a finding', () => {
  const text = findingText('F1', {
    id: 'c/m/1/0', path: 'a.ts', startLine: 3, endLine: 4, title: 'Guard the empty list', body: 'items may be empty.',
    meta: { severity: 'critical', category: 'security', importance: 9, confidence: 0.97, verdictReason: 'upheld: SECRET', samples: [0, 1, 2] },
  });
  assert.equal(text, 'F1 (lines 3-4): Guard the empty list\nitems may be empty.');
});
