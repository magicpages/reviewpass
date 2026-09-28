/**
 * Freeze the benchmark cases: one checkout per pull request at its head commit.
 *
 *   npx tsx benchmark/setup.ts eval/bench/spec.json
 *
 * Checkouts come from a `--shared` clone of the source repository rather than
 * from the source itself, for one reason that is easy to miss: reviewpass borrows
 * `node_modules` from the checkout a worktree belongs to, and a developer's clone
 * has them installed. Production reviews a fresh checkout with none, so static
 * analysis never runs there. A benchmark on a worktree of the developer's clone
 * would quietly run eslint and tsc and measure a reviewer nobody ships.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import type { Case, HistoryItem } from './types.js';

interface Spec {
  source: string;
  repo: string;
  clone: string;
  worktrees: string;
  history?: string;
  cases: { pr: number; head: string }[];
}

interface LabelledRow {
  pr: number; path: string; line: number; commit: string;
  title: string; body: string; label: 'good' | 'bad'; reason: string;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1e9 }).trim();

function pullRequest(repo: string, pr: number): { title: string; body: string; baseRefOid: string } {
  const out = execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'title,body,baseRefOid'],
    { encoding: 'utf8' });
  return JSON.parse(out) as { title: string; body: string; baseRefOid: string };
}

function main() {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('usage: setup.ts <spec.json>');
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
  const clone = resolve(spec.clone);
  if (!existsSync(join(clone, '.git'))) {
    git(dirname(clone), 'clone', '--quiet', '--shared', '--no-checkout', resolve(spec.source), clone);
  }
  if (existsSync(join(clone, 'node_modules'))) {
    throw new Error(`${clone} has node_modules; static analysis would run, which production does not do`);
  }
  const rows = spec.history ? JSON.parse(readFileSync(spec.history, 'utf8')) as LabelledRow[] : [];

  const cases: Case[] = [];
  for (const { pr, head: short } of spec.cases) {
    const meta = pullRequest(spec.repo, pr);
    const head = git(clone, 'rev-parse', '--verify', `${short}^{commit}`);
    const base = git(clone, 'merge-base', meta.baseRefOid, head);
    const workspace = resolve(spec.worktrees, String(pr));
    if (!existsSync(workspace)) {
      mkdirSync(dirname(workspace), { recursive: true });
      git(clone, 'worktree', 'add', '--quiet', '--detach', workspace, head);
    }
    if (git(workspace, 'rev-parse', 'HEAD') !== head) throw new Error(`${workspace} is not at ${head}`);

    const numstat = git(clone, 'diff', '--numstat', '--no-renames', `${base}...${head}`)
      .split('\n').filter(Boolean).map((l) => l.split('\t'));
    const diffBytes = Buffer.byteLength(git(clone, 'diff', '--no-renames', `${base}...${head}`));
    const history: HistoryItem[] = rows.filter((r) => r.pr === pr).map((r) => ({
      path: r.path, line: r.line, title: r.title, body: r.body, reason: r.reason,
      outcome: r.label === 'good' ? 'accepted' : 'declined',
    }));

    cases.push({
      id: String(pr), title: meta.title, body: meta.body ?? '', base, head, workspace,
      size: {
        files: numstat.length,
        added: numstat.reduce((s, [a]) => s + (Number(a) || 0), 0),
        removed: numstat.reduce((s, [, d]) => s + (Number(d) || 0), 0),
        diffBytes,
      },
      history,
    });
    console.log(`  ${pr}: ${numstat.length} files, +${cases.at(-1)!.size.added}/-${cases.at(-1)!.size.removed}, `
      + `${(diffBytes / 1024).toFixed(1)} KB, ${history.length} history items -> ${workspace}`);
  }
  const out = join(dirname(specPath), 'cases.json');
  writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
  console.log(`  wrote ${out}`);
}

main();
