/**
 * Without a config file every caller gets the shipped defaults. Each must get its
 * own copy: a daemon reviewing several repositories loads a config per review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
