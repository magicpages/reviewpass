/**
 * Two samples phrasing one defect in British and American spelling are one
 * finding. On a real review, "Normalise to NFC before tokenising" and
 * "Normalize to NFC before tokenizing" were posted side by side on one line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseNearDuplicates } from '../src/review/run.js';
import type { Finding } from '../src/types.js';

const at = (title: string, body: string): Finding => ({
  path: 'site-move-match.ts', startLine: 132, endLine: 132, severity: 'minor', category: 'correctness', title, body,
});

// The exact titles and opening sentences the pair was posted with.
const british = at('Normalise to NFC before tokenising and trigramming',
  'The new Unicode classes match letters, but the code never normalises to a single Unicode form.');
const american = at('Normalize to NFC before tokenizing so canonically equal slugs match',
  'The change makes tokens Unicode-aware but compares raw codepoints.');
const other = at('Slice trigrams by code point, not UTF-16 code unit, or astral characters produce broken grams',
  'The diff makes the strip regex keep Unicode letters, so astral characters now survive into `padded`.');

test('British and American spellings of one finding collapse into one', () => {
  assert.equal(collapseNearDuplicates([british, american]).length, 1);
});

test('a different point on the same line is still kept apart', () => {
  assert.equal(collapseNearDuplicates([british, american, other]).length, 2);
});
