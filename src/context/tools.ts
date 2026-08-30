import { execFile, execFileSync } from 'node:child_process';
import { parseJsonc } from './jsonc.js';
import { promisify } from 'node:util';
import { existsSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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
/**
 * Borrow installed dependencies from the checkout this worktree came from.
 *
 * The early version required `node_modules` at the repository root and gave up
 * otherwise, so a repository whose application lives in a subdirectory — the
 * common `application/`, `apps/`, `packages/` shape — got no static analysis at
 * all, even with dependencies installed. Two reviews of such a repository ran
 * with no type checking and never said why beyond "none to link".
 *
 * So: find every install in the source checkout and mirror it at the same
 * relative path. Anything linked counts, because a monorepo that type checks
 * per package needs the package's own tree more than the root's.
 */
export function linkDependencies(root: string): boolean {
  let main: string;
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' }).trim();
    main = dirname(common);                       // .../repo/.git -> .../repo
  } catch {
    // Not a worktree: whatever is here is all there is.
    return existsSync(join(root, 'node_modules'));
  }
  if (main === root) return existsSync(join(root, 'node_modules'));

  let linked = existsSync(join(root, 'node_modules'));
  const link = (rel: string) => {
    const from = join(main, rel);
    const to = join(root, rel);
    if (!existsSync(from)) return;
    // Already linked by an earlier run over the same worktree. That is success,
    // not a reason to skip: treating it as "nothing linked" made the whole of
    // static analysis sit out every run after the first.
    if (existsSync(to)) { linked = true; return; }
    try {
      symlinkSync(from, to, 'dir');
      linked = true;
    } catch { /* best effort: one package failing must not lose the rest */ }
  };

  link('node_modules');
  for (const pkg of listWorkspaceDirs(root)) link(join(pkg, 'node_modules'));
  // Workspace globs are declared by the package that owns them, which a
  // repository with no root `package.json` never exposes. Look for the installs
  // directly, shallowly, and skip anything already inside a `node_modules`.
  for (const dir of findInstalls(main, 3)) link(dir);
  return linked;
}

/** Relative paths of `node_modules` directories, to a bounded depth. */
function findInstalls(base: string, depth: number, rel = ''): string[] {
  if (depth <= 0) return [];
  const out: string[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(join(base, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name === 'node_modules') { out.push(join(rel, e.name)); continue; }
    out.push(...findInstalls(base, depth - 1, join(rel, e.name)));
  }
  return out;
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

/**
 * Whether the project's types can be trusted to exclude null and undefined.
 *
 * This decides whether a whole class of finding is worth anything. "Guard
 * against `x` being undefined" is a real defect when the compiler is not
 * enforcing it and dead code when it is — eight such findings on one pull
 * request were declined with the same sentence, that the value is typed
 * non-optional and comes from the repository's own constants. Writing the guard
 * anyway produces code `@typescript-eslint/no-unnecessary-condition` then flags.
 *
 * Without `strictNullChecks` TypeScript erases null and undefined from types
 * entirely, so a non-optional annotation proves nothing and the same finding
 * becomes legitimate. The verifier cannot see a tsconfig, so it is read here.
 *
 * `noUncheckedIndexedAccess` is reported separately and deliberately not folded
 * in: it is the exception rather than a strengthening. Array elements and index
 * signatures are possibly-undefined at runtime whatever the annotation says,
 * which is precisely the documented false positive of the lint rule above.
 */
export interface TypeStrictness {
  strictNullChecks: boolean;
  noUncheckedIndexedAccess: boolean;
}

export function typeStrictness(root: string, forPath?: string): TypeStrictness {
  const seen = new Set<string>();

  const read = (file: string, depth = 0): TypeStrictness | undefined => {
    if (depth > 5 || seen.has(file) || !existsSync(file)) return undefined;
    seen.add(file);
    try {
      const cfg = parseJsonc<{
        extends?: string;
        compilerOptions?: { strict?: boolean; strictNullChecks?: boolean; noUncheckedIndexedAccess?: boolean };
      }>(readFileSync(file, 'utf8'));
      if (!cfg) return undefined;
      const o = cfg.compilerOptions ?? {};
      // A local `false` beats an inherited `true`, so only fall through to the
      // base config for options this file does not mention at all.
      const inherited = cfg.extends && !cfg.extends.startsWith('@')
        ? read(resolve(dirname(file), cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`), depth + 1)
        : undefined;
      return {
        strictNullChecks: o.strictNullChecks ?? o.strict ?? inherited?.strictNullChecks ?? false,
        noUncheckedIndexedAccess: o.noUncheckedIndexedAccess ?? inherited?.noUncheckedIndexedAccess ?? false,
      };
    } catch {
      return undefined;
    }
  };

  // The nearest tsconfig to the file under review, then the repository root.
  const candidates: string[] = [];
  if (forPath) {
    const parts = forPath.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      candidates.push(join(root, parts.slice(0, i).join('/'), 'tsconfig.json'));
    }
  }
  candidates.push(join(root, 'tsconfig.json'));

  for (const c of candidates) {
    const found = read(c);
    if (found) return found;
  }
  return { strictNullChecks: false, noUncheckedIndexedAccess: false };
}
