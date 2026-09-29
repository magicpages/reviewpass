/**
 * Without a config file every caller gets the shipped defaults. Each must get its
 * own copy: a daemon reviewing several repositories loads a config per review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.js';

const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));

test("changing one caller's config does not change the next caller's defaults", () => {
  const a = fresh();
  const name = a.model.name;
  a.model.name = 'changed-by-one-caller';
  a.model.verifyReasoningEffort = 'none';
  const b = fresh();
  assert.equal(b.model.name, name);
  assert.equal(b.model.verifyReasoningEffort, undefined);
});

test('a config file without a model section does not keep one run\'s environment for the next', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewpass-cfg-'));
  writeFileSync(join(dir, '.reviewpass.yaml'), 'review:\n  requestChangesAt: critical\n');
  process.env.REVIEWPASS_VERIFY_REASONING_EFFORT = 'none';
  try {
    assert.equal(loadConfig(dir).model.verifyReasoningEffort, 'none');
  } finally {
    delete process.env.REVIEWPASS_VERIFY_REASONING_EFFORT;
  }
  assert.equal(loadConfig(dir).model.verifyReasoningEffort, undefined, 'the override leaked into the defaults');
});
