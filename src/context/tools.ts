import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ReviewpassConfig } from '../config/index.js';

const exec = promisify(execFile);

/**
 * Static analysis.
 *
 * Mature review tooling feeds dozens of linters into the prompt. We do something narrower but
 * more useful: run the repository's *own* configured linters, because those
 * already encode the team's rules. Their output is passed to the model as
 * "already reported" so it does not waste findings restating them.
 */

export interface ToolFinding {
  path: string;
  line: number;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

async function run(cmd: string, args: string[], cwd: string, timeout = 180_000) {
  try {
    const { stdout } = await exec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout });
    return { ok: true, out: stdout };
  } catch (err) {
    // Linters exit non-zero when they find problems: that is the success case.
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

interface EslintMessage { line: number; ruleId: string | null; message: string; severity: number }
interface EslintResult { filePath: string; messages: EslintMessage[] }

async function runEslint(root: string, paths: string[]): Promise<ToolFinding[]> {
  const hasConfig = [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
    '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.yml',
  ].some((f) => existsSync(join(root, f)));
  if (!hasConfig) return [];

  const lintable = paths.filter((p) => /\.[cm]?[jt]sx?$/.test(p));
  if (!lintable.length) return [];

  const { out } = await run('npx', ['--no-install', 'eslint', '--format', 'json', ...lintable], root);
  if (!out.trim()) return [];
  try {
    const results = JSON.parse(out) as EslintResult[];
    return results.flatMap((r) =>
      r.messages.map((m) => ({
        path: r.filePath.replace(`${root}/`, ''),
        line: m.line,
        rule: m.ruleId ?? 'eslint',
        message: m.message,
        severity: m.severity === 2 ? ('error' as const) : ('warning' as const),
      })).filter((f) =>
        // Not a defect: eslint says this when asked about a file its config
        // excludes. It arrived anchored to line `undefined` and read as a warning.
        !/File ignored because of a matching ignore pattern/i.test(f.message)),
    );
  } catch {
    return [];
  }
}

/**
 * `tsc --noEmit`, run where the tsconfig actually lives.
 *
 * A monorepo keeps a tsconfig per package, and running only the root one type
 * checks almost nothing. The packages owning the changed files are the ones
 * worth checking, so those are the ones run.
 */
async function runTsc(root: string, paths: string[]): Promise<ToolFinding[]> {
  // Packages owning a changed file, plus the root when it stands alone.
  const dirs = new Set<string>();
  for (const p of paths) {
    let dir = dirname(p);
    while (dir && dir !== '.') {
      if (existsSync(join(root, dir, 'tsconfig.json'))) { dirs.add(dir); break; }
      dir = dirname(dir);
    }
  }
  if (!dirs.size && existsSync(join(root, 'tsconfig.json'))) dirs.add('.');
  if (!dirs.size) return [];

  const wanted = new Set(paths);
  const findings: ToolFinding[] = [];
  let unresolvedImports = 0;
  for (const dir of dirs) {
    const cwd = dir === '.' ? root : join(root, dir);
    const { out } = await run('npx', ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'], cwd, 300_000);
    for (const line of out.split('\n')) {
      const m = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line.trim());
      if (!m) continue;
      // TS2307 is "cannot find module". A handful is a real defect; a flood
      // means the dependencies are not installed for this package and every
      // third-party import looks broken. Reporting those as review findings
      // would be worse than running nothing at all.
      if (m[3] === 'TS2307') unresolvedImports++;
      // tsc reports relative to its own cwd; re-root it on the repository.
      const rel = m[1]!.replace(`${cwd}/`, '');
      const path = dir === '.' ? rel : `${dir}/${rel}`;
      if (!wanted.has(path)) continue;
      findings.push({ path, line: Number(m[2]), rule: m[3]!, message: m[4]!, severity: 'error' });
    }
  }
  return findings;
}

/** A custom command emitting `path:line: message` lines. */
async function runCustom(root: string, cmd: string): Promise<ToolFinding[]> {
  const [bin, ...args] = cmd.split(' ');
  if (!bin) return [];
  const { out } = await run(bin, args, root);
  const findings: ToolFinding[] = [];
  for (const line of out.split('\n')) {
    const m = /^(.+?):(\d+):(?:\d+:)?\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    findings.push({ path: m[1]!, line: Number(m[2]), rule: bin, message: m[3]!, severity: 'warning' });
  }
  return findings;
}


/**
 * Make the toolchain runnable in an ephemeral worktree.
 *
 * Reviews run from a detached worktree, which has source but no
 * `node_modules` - so `npx --no-install tsc` failed, the error was swallowed by
 * a `catch`, and static analysis returned an empty list that was indistinguishable
 * from a clean run. Every worktree review ever done had this capability silently
 * switched off.
 *
 * Linking the primary checkout's dependencies costs nothing and needs no
 * install. The versions match because the worktree shares the repository.
 */
function linkDependencies(root: string): boolean {
  if (existsSync(join(root, 'node_modules'))) return true;
  let main: string;
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' }).trim();
    main = dirname(common);                       // .../repo/.git -> .../repo
  } catch {
    return false;
  }
  if (!existsSync(join(main, 'node_modules'))) return false;

  try {
    symlinkSync(join(main, 'node_modules'), join(root, 'node_modules'), 'dir');
    // Workspace packages keep their own trees; link whichever exist.
    for (const pkg of listWorkspaceDirs(root)) {
      const from = join(main, pkg, 'node_modules');
      const to = join(root, pkg, 'node_modules');
      if (existsSync(from) && !existsSync(to)) {
        try { symlinkSync(from, to, 'dir'); } catch { /* best effort */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Workspace package directories.
 *
 * npm and yarn declare these in `package.json`; pnpm keeps them in
 * `pnpm-workspace.yaml`, and this repository uses pnpm - so reading only
 * `package.json` found nothing, no package-level dependencies were linked, and
 * the type checker reported every third-party import as a missing module.
 */
function listWorkspaceDirs(root: string): string[] {
  const globs: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as
      { workspaces?: string[] | { packages?: string[] } };
    globs.push(...(Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? []));
  } catch { /* no package.json, or not a workspace root */ }
  try {
    // Deliberately not a YAML parse: the file is a list of quoted globs.
    for (const m of readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
      .matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)) globs.push(m[1]!.trim());
  } catch { /* not pnpm */ }

  const out: string[] = [];
  for (const g of globs) {
    const base = g.replace(/\/\*+$/, '');
    if (base === g) { out.push(base); continue; }
    try {
      for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
        if (e.isDirectory()) out.push(`${base}/${e.name}`);
      }
    } catch { /* glob base absent */ }
  }
  return [...new Set(out)];
}

export async function runTools(
  root: string,
  paths: string[],
  cfg: ReviewpassConfig,
  log?: (m: string) => void,
): Promise<ToolFinding[] | null> {
  if (!linkDependencies(root)) {
    // Say so rather than returning an empty list that reads as "all clean".
    log?.('static analysis skipped: no node_modules in the workspace and none to link');
    return null;
  }
  const jobs: Promise<ToolFinding[]>[] = [];
  if (cfg.tools.eslint) jobs.push(runEslint(root, paths).catch(() => []));
  if (cfg.tools.tsc) jobs.push(runTsc(root, paths).catch(() => []));
  for (const c of cfg.tools.custom) jobs.push(runCustom(root, c).catch(() => []));
  const all = await Promise.all(jobs);
  return all.flat();
}

export function toolFindingsFor(findings: ToolFinding[], path: string): string[] {
  return findings
    .filter((f) => f.path === path || f.path.endsWith(`/${path}`))
    .slice(0, 40)
    .map((f) => `${f.severity} ${f.rule} at line ${f.line}: ${f.message}`);
}
