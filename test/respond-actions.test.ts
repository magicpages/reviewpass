/**
 * The reply pass says less: a fix is resolved without a word, and a reply that
 * cites a commit not yet on the pull request is not judged against the old code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionFor, citedCommits, unseenCommits } from '../src/respond.js';

test('a fix is resolved quietly; a concession is resolved and remembered; a hold is answered and left open', () => {
  assert.deepEqual(actionFor('fixed'), { reply: false, resolve: true, remember: false });
  assert.deepEqual(actionFor('concede'), { reply: true, resolve: true, remember: true });
  assert.deepEqual(actionFor('hold'), { reply: true, resolve: false, remember: false });
});

test('the commits a reply cites are found, and words that only look like hex are not', () => {
  assert.deepEqual(citedCommits('Fixed in `0d73304` and 9d3b26353.'), ['0d73304', '9d3b26353']);
  assert.deepEqual(citedCommits('the deadbeef fixture, 1234567 rows, #e5dcf9'), []);
});

test('a cited commit is unseen until it is on the pull request, however shallow the checkout', () => {
  const onPr = ['52378be670826dc6f07b15f19d9d37620b6f6b49', '9d3b263531b24071031de2edee74b1ee9da20515'];
  assert.deepEqual(unseenCommits(['9d3b263', '0d73304'], onPr), ['0d73304'], 'an earlier fix commit is on the branch');
  assert.deepEqual(unseenCommits(['0d73304'], undefined), [], 'without the list nothing is skipped');
});
