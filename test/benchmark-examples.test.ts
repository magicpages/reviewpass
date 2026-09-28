/**
 * The example configs are what a newcomer copies. They must match the shape the
 * harness reads, and name keys by environment variable, so nobody learns from
 * them to paste a key into a file that sits next to committed code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../benchmark/examples/${name}`, import.meta.url), 'utf8'));

test('the example run config has every key the orchestrator reads, and no secrets', () => {
  const cfg = read('run-config.example.json');
  for (const k of ['cases', 'out', 'runs', 'parallel', 'keyEnv', 'methods', 'judges', 'spendCap']) assert.ok(k in cfg, k);
  assert.match(cfg.keyEnv, /^[A-Z][A-Z0-9_]*$/);
  for (const m of cfg.methods) {
    assert.ok(m.kind === 'reviewpass' || m.kind === 'raw');
    for (const k of ['endpoint', 'name', 'maxTokens']) assert.ok(k in m.model, k);
  }
  for (const role of ['first', 'second', 'tiebreak']) {
    const j = cfg.judges[role];
    for (const k of ['name', 'endpoint', 'model', 'keyEnv', 'price']) assert.ok(k in j, `${role}.${k}`);
    assert.ok(!('key' in j), `${role} must name its key by environment variable, not carry it`);
    assert.match(j.keyEnv, /^[A-Z][A-Z0-9_]*$/);
  }
  assert.doesNotMatch(JSON.stringify(cfg), /sk-|Bearer /, 'an example must never carry a credential');
});

test('the example spec and history have the fields setup reads', () => {
  const spec = read('spec.example.json');
  for (const k of ['source', 'repo', 'clone', 'worktrees', 'cases']) assert.ok(k in spec, k);
  for (const c of spec.cases) assert.ok(Number.isInteger(c.pr) && typeof c.head === 'string');
  for (const row of read('history.example.json')) {
    for (const k of ['pr', 'path', 'line', 'commit', 'title', 'body', 'label', 'reason']) assert.ok(k in row, k);
    assert.ok(row.label === 'good' || row.label === 'bad');
  }
});
