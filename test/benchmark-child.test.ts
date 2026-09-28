/**
 * A run that could not deliver its result must still leave one: a gap reads as
 * a run with no findings, and a command that cannot start must not take the
 * whole benchmark down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnRun } from '../benchmark/child.js';
import type { Run } from '../benchmark/types.js';

const failed = (why: string): Run => ({ caseId: 'c', method: 'm', run: 1, findings: [], refuted: [], wallMs: 0,
  promptTokens: 0, completionTokens: 0, error: why });

async function inTmp(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-child-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a command that cannot start is recorded as a failed run, and the promise still resolves', () => inTmp(async (dir) => {
  const out = join(dir, 'run.json');
  await spawnRun('no-such-command-for-this-test', [], process.env, out, failed);
  const run = JSON.parse(readFileSync(out, 'utf8')) as Run;
  assert.match(run.error ?? '', /^could not start no-such-command-for-this-test: .*ENOENT/);
}));

test('a child that dies without its result leaves the failure and its stderr', () => inTmp(async (dir) => {
  const out = join(dir, 'run.json');
  await spawnRun(process.execPath, ['-e', 'console.error("model unreachable"); process.exit(3)'], process.env, out, failed);
  const run = JSON.parse(readFileSync(out, 'utf8')) as Run;
  assert.equal(run.error, 'worker exited 3: model unreachable');
  assert.match(readFileSync(join(dir, 'run.log'), 'utf8'), /model unreachable/);
}));

test('a child that wrote its result is left alone', () => inTmp(async (dir) => {
  const out = join(dir, 'run.json');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(out)}, '{"ok":true}')`;
  await spawnRun(process.execPath, ['-e', script], process.env, out, failed);
  assert.equal(readFileSync(out, 'utf8'), '{"ok":true}');
  assert.ok(existsSync(join(dir, 'run.log')));
}));
