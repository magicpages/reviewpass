/**
 * Adding runs to a judged benchmark places their findings into the existing
 * reference instead of judging everything again. Findings that fit an existing
 * cause cost two placements; only those fitting none become new causes, with ids
 * that cannot collide with the old ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extendReference, renumberCauses, unplacedFindings } from '../benchmark/reference.js';
import { Spend, type Judge } from '../benchmark/judges.js';
import type { BenchFinding, Case, ReferenceEntry } from '../benchmark/types.js';

const finding = (id: string): BenchFinding => ({ id, path: 'a.ts', startLine: 2, endLine: 2, title: `t ${id}`, body: 'b' });

test('only findings the reference has not placed are new', () => {
  const pool = [finding('old'), finding('new')];
  assert.deepEqual(unplacedFindings(pool, [['old', 'c#0']]).map((f) => f.id), ['new']);
});

test('new causes get ids apart from the old ones, and their placements follow', () => {
  const e = { id: 'c/a.ts#0', caseId: 'c', path: 'a.ts', members: ['n1'], mechanism: 'm', defect: true,
    severity: 'high', verdicts: [], settledBy: 'agreement' } satisfies ReferenceEntry;
  const out = renumberCauses([e], new Map([['n1', 'c/a.ts#0'], ['n2', null]]), 'x1');
  assert.equal(out.entries[0]!.id, 'c/a.ts#0+x1');
  assert.deepEqual([...out.placed], [['n1', 'c/a.ts#0+x1'], ['n2', null]]);
});

/** A judge endpoint that answers whatever schema it is sent, choosing causes by `pick`. */
async function stubJudges(pick: (causes: string[], placement: number) => string, fn: (j: Judge, kinds: string[]) => Promise<void>) {
  const kinds: string[] = [];
  let placements = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const props = JSON.parse(raw).response_format.json_schema.schema.properties;
      const kind = Object.keys(props)[0]!;
      kinds.push(kind);
      const item = props[kind].items.properties;
      const n = kind === 'placements' ? placements++ : -1;
      const answer = kind === 'placements'
        ? { placements: item.finding.enum.map((f: string) => ({ finding: f, cause: pick(item.cause.enum, n) })) }
        : kind === 'groups'
          ? { groups: [{ mechanism: 'a new mechanism', members: item.members.items.enum }] }
          : { rulings: item.cause.enum.map((c: string) => ({ cause: c, defect: true, severity: 'high', reason: 'r' })) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }], usage: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    await fn({ name: 'stub', endpoint: `http://127.0.0.1:${port}/v1`, model: 'm', key: 'k', price: { input: 0, output: 0 } }, kinds);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function workspace(): Case {
  const dir = mkdtempSync(join(tmpdir(), 'bench-extend-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'one\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n');
  git('commit', '-qam', 'head');
  return { id: 'c', title: 't', body: '', base, head: git('rev-parse', 'HEAD'), workspace: dir,
    size: { files: 1, added: 1, removed: 0, diffBytes: 0 }, history: [] };
}

const existing: ReferenceEntry[] = [{ id: 'c/a.ts#0', caseId: 'c', path: 'a.ts', members: ['old'], mechanism: 'known',
  defect: true, severity: 'high', verdicts: [], settledBy: 'agreement' }];

test('findings that fit an existing cause are placed without judging anything new', async () => {
  const c = workspace();
  await stubJudges((cs) => cs[0]!, async (judge, kinds) => {
    const ext = await extendReference(c, [finding('n1'), finding('n2')], existing, { first: judge, second: judge, tiebreak: judge },
      new Spend(1), 'x1');
    assert.deepEqual([...ext.placed], [['n1', 'c/a.ts#0'], ['n2', 'c/a.ts#0']]);
    assert.equal(ext.entries.length, 0);
    assert.deepEqual(kinds, ['placements', 'placements'], 'one blind placement per judge, no grouping, no rulings');
  });
});

test('a finding no judge can place becomes a new cause, apart from the old ids', async () => {
  const c = workspace();
  // Both blind placements against the old causes say "none"; later ones pick the new cause.
  await stubJudges((cs, n) => (n < 2 ? 'none' : cs[0]!), async (judge, kinds) => {
    const ext = await extendReference(c, [finding('n1')], existing, { first: judge, second: judge, tiebreak: judge }, new Spend(1), 'x1');
    assert.equal(ext.entries.length, 1);
    assert.equal(ext.entries[0]!.id, 'c/a.ts#0+x1', 'must not collide with the existing c/a.ts#0');
    assert.equal(ext.entries[0]!.mechanism, 't n1 b', 'a single finding is its own mechanism, no grouping call');
    assert.deepEqual([...ext.placed], [['n1', 'c/a.ts#0+x1']]);
    assert.deepEqual(kinds, ['placements', 'placements', 'rulings', 'rulings', 'placements']);
  });
});
