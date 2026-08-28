import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const exec = promisify(execFile);

/**
 * Repository search with a portable fallback chain.
 *
 * ripgrep is the fast path, but a GitHub runner may not have it and some shells
 * expose `rg`/`grep` only as functions, which `execFile` cannot see. So the last
 * resort is a bounded walker in Node — slower, but it always works, and a
 * reviewer that silently retrieves nothing is worse than a slow one.
 */

export interface Match {
  path: string;
  line: number;
  text: string;
}

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo',
  'vendor', '__snapshots__', '.cache', 'out', 'tmp', '.yarn', '.pnpm-store',
]);
const SOURCE_EXT = /\.(m?[jt]sx?|cjs|cts|mts|json|ya?ml|sql|md|sh|rb|py|go|rs|php)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_SCANNED = 6000;

let backend: 'rg' | 'grep' | 'js' | null = null;

async function detectBackend(cwd: string): Promise<'rg' | 'grep' | 'js'> {
  if (backend) return backend;
  for (const bin of ['rg', 'grep'] as const) {
    try {
      await exec(bin, ['--version'], { cwd, timeout: 5000 });
      backend = bin;
      return backend;
    } catch {
      // try the next one
    }
  }
  backend = 'js';
  return backend;
}

/** Which search implementation is in use — surfaced in logs for diagnosis. */
export async function searchBackend(cwd: string): Promise<string> {
  return detectBackend(cwd);
}

export interface SearchOptions {
  /** Lines of surrounding context, mirroring ripgrep's -C. */
  context?: number;
  maxMatches?: number;
  /** Restrict to these path prefixes. */
  within?: string[];
}

export async function searchRepo(root: string, pattern: string, opts: SearchOptions = {}): Promise<Match[]> {
  const { context = 3, maxMatches = 8 } = opts;
  const kind = await detectBackend(root);

  if (kind === 'rg') {
    const args = [
      '-n', '--no-heading', '--color', 'never',
      '-C', String(context), '--max-count', String(maxMatches),
      '-e', pattern, ...(opts.within ?? ['.']),
    ];
    return parseGrepish(await runQuiet('rg', args, root));
  }

  if (kind === 'grep') {
    const args = [
      '-rn', '-I', `-C${context}`, `-m${maxMatches}`,
      '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=dist',
      '--exclude-dir=build', '--exclude-dir=coverage',
      '-E', pattern, ...(opts.within ?? ['.']),
    ];
    return parseGrepish(await runQuiet('grep', args, root));
  }

  return jsSearch(root, pattern, context, maxMatches, opts.within);
}

async function runQuiet(bin: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(bin, args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 45_000 });
    return stdout;
  } catch (err) {
    // Exit 1 means "no matches", which is an answer rather than an error.
    return (err as { stdout?: string }).stdout ?? '';
  }
}

/** `path:line:text` and `path-line-text` (context lines) from rg and grep alike. */
function parseGrepish(out: string): Match[] {
  const matches: Match[] = [];
  for (const raw of out.split('\n')) {
    const m = /^(.+?)[:-](\d+)[:-](.*)$/.exec(raw);
    if (!m) continue;
    matches.push({ path: m[1]!.replace(/^\.\//, ''), line: Number(m[2]), text: m[3]! });
  }
  return matches;
}

async function listSourceFiles(root: string, within?: string[]): Promise<string[]> {
  const out: string[] = [];
  const roots = within?.length ? within.map((w) => join(root, w)) : [root];

  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES_SCANNED) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_SCANNED) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        out.push(full);
      }
    }
  };

  for (const r of roots) {
    try {
      const s = await stat(r);
      if (s.isFile()) out.push(r);
      else await walk(r);
    } catch {
      // a `within` path that does not exist is simply skipped
    }
  }
  return out;
}

async function jsSearch(
  root: string, pattern: string, context: number, maxMatches: number, within?: string[],
): Promise<Match[]> {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return [];
  }

  const files = await listSourceFiles(root, within);
  const matches: Match[] = [];

  for (const file of files) {
    if (matches.length >= maxMatches) break;
    let text: string;
    try {
      const s = await stat(file);
      if (s.size > MAX_FILE_BYTES) continue;
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!re.test(text)) continue;

    const lines = text.split('\n');
    const rel = relative(root, file);
    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      if (!re.test(lines[i]!)) continue;
      const from = Math.max(0, i - context);
      const to = Math.min(lines.length - 1, i + context);
      for (let j = from; j <= to; j++) {
        matches.push({ path: rel, line: j + 1, text: lines[j]! });
      }
      i = to;
    }
  }
  return matches;
}

/** Files whose basename matches, e.g. locating `email-change.test.ts` anywhere. */
export async function findByName(root: string, names: string[], limit = 4): Promise<string[]> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const files = await listSourceFiles(root);
  const out: string[] = [];
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    if (wanted.has(base)) {
      out.push(relative(root, f));
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Render matches the way a reviewer reads grep output. */
export function renderMatches(matches: Match[], maxChars = 3000): string {
  const byFile = new Map<string, Match[]>();
  for (const m of matches) {
    const list = byFile.get(m.path);
    if (list) list.push(m);
    else byFile.set(m.path, [m]);
  }
  const parts: string[] = [];
  let used = 0;
  for (const [path, list] of byFile) {
    const block = `${path}\n${list.map((m) => `${String(m.line).padStart(5)}  ${m.text}`).join('\n')}`;
    if (used + block.length > maxChars) break;
    used += block.length;
    parts.push(block);
  }
  return parts.join('\n\n');
}
