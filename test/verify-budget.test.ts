/**
 * The verify call's ceiling has to clear the server's reasoning budget.
 *
 * A model told it may think up to 4096 tokens, inside a response capped at
 * 2048, can spend the whole allowance thinking and never reach a verdict. The
 * ceiling was a constant, so there was no way to lift it to match whatever the
 * server is running — and on this hardware lifting it measured 17/21 -> 18/21
 * recall with the wall time halved, 108 min -> 61.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBudget, verifyTemperature } from '../src/review/run.js';

// `envAny` reads REVIEWPASS_<name> and falls back to WARREN_<name>, so clearing
// one name does not unset the override. A machine with the legacy name exported
// would otherwise fail these tests for a reason that has nothing to do with the
// code under test.
const NAMES = [
  'REVIEWPASS_VERIFY_MAX_TOKENS', 'WARREN_VERIFY_MAX_TOKENS',
  'REVIEWPASS_VERIFY_TEMPERATURE', 'WARREN_VERIFY_TEMPERATURE',
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]!;
  }
});

describe('verifyBudget', () => {
  test('defaults to the previous constant when nothing is set', () => {
    assert.equal(verifyBudget(2048), 2048);
    assert.equal(verifyBudget(4096), 4096);
  });

  test('takes the override when one is set', () => {
    process.env.REVIEWPASS_VERIFY_MAX_TOKENS = '8192';
    assert.equal(verifyBudget(2048), 8192);
  });

  test('honours the legacy WARREN_ name', () => {
    process.env.WARREN_VERIFY_MAX_TOKENS = '8192';
    assert.equal(verifyBudget(2048), 8192);
  });

  test('ignores anything that is not a whole positive token count', () => {
    // A bad value must not become a tiny budget: that truncates every verdict,
    // which reads as the model refusing rather than as a config error. `2048.5`
    // is the subtle one — it is finite, and no server can honour it.
    for (const bad of ['nonsense', '0', '-1', '2048.5', '', '   ', '1e3.5']) {
      process.env.REVIEWPASS_VERIFY_MAX_TOKENS = bad;
      assert.equal(verifyBudget(2048), 2048, `"${bad}" should fall back`);
    }
  });
});

describe('verifyTemperature', () => {
  const cfg = { model: { temperature: 0.1 } } as never;

  test('defaults to the configured temperature', () => {
    assert.equal(verifyTemperature(cfg), 0.1);
  });

  test('takes an override, including a deliberate zero', () => {
    process.env.REVIEWPASS_VERIFY_TEMPERATURE = '0.6';
    assert.equal(verifyTemperature(cfg), 0.6);
    process.env.REVIEWPASS_VERIFY_TEMPERATURE = '0';
    assert.equal(verifyTemperature(cfg), 0, 'an explicit 0 is a real choice');
  });

  test('falls back on empty or blank, which Number() would read as zero', () => {
    // The trap: `Number('')` is 0, so an unset-but-present variable would pin
    // verification to greedy decoding — the one setting Qwen documents as
    // harmful in thinking mode.
    for (const blank of ['', '   ', '\t']) {
      process.env.REVIEWPASS_VERIFY_TEMPERATURE = blank;
      assert.equal(verifyTemperature(cfg), 0.1, `"${blank}" should fall back`);
    }
  });
});
