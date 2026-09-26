/**
 * The verify call's ceiling has to clear the server's reasoning budget.
 *
 * A model told it may think up to 4096 tokens, inside a response capped at
 * 2048, can spend the whole allowance thinking and never reach a verdict. The
 * ceiling was a constant, so there was no way to lift it to match whatever the
 * server is running — and on this hardware lifting it measured 17/21 -> 18/21
 * recall with the wall time halved, 108 min -> 61.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBudget, verifyTemperature } from '../src/review/run.js';

describe('verifyBudget', () => {
  test('defaults to the previous constant when nothing is set', () => {
    delete process.env.REVIEWPASS_VERIFY_MAX_TOKENS;
    assert.equal(verifyBudget(2048), 2048);
    assert.equal(verifyBudget(4096), 4096);
  });

  test('takes the override when one is set', () => {
    process.env.REVIEWPASS_VERIFY_MAX_TOKENS = '8192';
    try { assert.equal(verifyBudget(2048), 8192); }
    finally { delete process.env.REVIEWPASS_VERIFY_MAX_TOKENS; }
  });

  test('ignores a value that is not a usable ceiling', () => {
    // A bad value must not silently become a tiny budget: that would truncate
    // every verdict, which looks like the model refusing rather than a config
    // error.
    for (const bad of ['nonsense', '0', '-1', '']) {
      process.env.REVIEWPASS_VERIFY_MAX_TOKENS = bad;
      try { assert.equal(verifyBudget(2048), 2048, `"${bad}" should fall back`); }
      finally { delete process.env.REVIEWPASS_VERIFY_MAX_TOKENS; }
    }
  });
});

describe('verifyTemperature', () => {
  const cfg = { model: { temperature: 0.1 } } as never;
  test('defaults to the configured temperature', () => {
    delete process.env.REVIEWPASS_VERIFY_TEMPERATURE;
    assert.equal(verifyTemperature(cfg), 0.1);
  });
  test('allows an override, including a deliberate zero', () => {
    process.env.REVIEWPASS_VERIFY_TEMPERATURE = '0.6';
    try { assert.equal(verifyTemperature(cfg), 0.6); }
    finally { delete process.env.REVIEWPASS_VERIFY_TEMPERATURE; }
    process.env.REVIEWPASS_VERIFY_TEMPERATURE = '0';
    try { assert.equal(verifyTemperature(cfg), 0); }
    finally { delete process.env.REVIEWPASS_VERIFY_TEMPERATURE; }
  });
});
