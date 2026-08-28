import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);

/**
 * Local bare mirrors, one per repository.
 *
 * A GitHub Action normally checks out the PR on every run. On our own hardware
 * that is wasted work: keeping a mirror means a review fetches only the new refs
 * and gets the *whole* history for free — which matters because the context
 * engine reads files far outside the diff, and a shallow checkout starves it.
 *
 * Reviews run in a throwaway worktree so concurrent runs never fight over HEAD.
 */

export interface MirrorOptions {
  root: string;          // e.g. /var/lib/reviewpass/mirrors
  owner: string;
  repo: string;
  token?: string;        // for private repositories
}

async function git(args: string[], cwd?: string, timeout = 600_000): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',           // never block waiting for credentials
    },
  });
  return stdout;
}

export function mirrorPath(o: MirrorOptions): string {
  return join(o.root, o.owner, `${o.repo}.git`);
}

function remoteUrl(o: MirrorOptions): string {
  return o.token
    ? `https://x-access-token:${o.token}@github.com/${o.owner}/${o.repo}.git`
    : `https://github.com/${o.owner}/${o.repo}.git`;
}

/** Create the mirror if missing, otherwise fetch. Returns the mirror path. */
export async function syncMirror(o: MirrorOptions): Promise<string> {
  const path = mirrorPath(o);
  if (!existsSync(path)) {
    mkdirSync(join(o.root, o.owner), { recursive: true });
    await git(['clone', '--mirror', remoteUrl(o), path], undefined, 1_800_000);
    return path;
  }
  // The URL carries a short-lived token, so refresh it before every fetch.
  await git(['remote', 'set-url', 'origin', remoteUrl(o)], path);
  // Pull request heads are not fetched by a plain mirror.
  await git([
    'fetch', '--prune', 'origin',
    '+refs/heads/*:refs/heads/*',
    '+refs/pull/*/head:refs/pull/*/head',
  ], path);
  return path;
}

/** Make sure a specific commit is present, fetching it directly if not. */
export async function ensureCommit(path: string, sha: string, o: MirrorOptions): Promise<boolean> {
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`], path);
    return true;
  } catch {
    try {
      await git(['remote', 'set-url', 'origin', remoteUrl(o)], path);
      await git(['fetch', 'origin', sha], path);
      return true;
    } catch {
      return false;
    }
  }
}

export interface Worktree {
  path: string;
  dispose(): Promise<void>;
}

/**
 * A detached worktree at `sha`. Cheap next to a clone because it shares the
 * mirror's object store.
 */
export async function createWorktree(mirror: string, sha: string, workRoot: string): Promise<Worktree> {
  mkdirSync(workRoot, { recursive: true });
  const path = join(workRoot, `${sha.slice(0, 12)}-${process.pid}-${Date.now().toString(36)}`);
  await git(['worktree', 'add', '--detach', '--force', path, sha], mirror);
  return {
    path,
    dispose: async () => {
      try {
        await git(['worktree', 'remove', '--force', path], mirror);
      } catch {
        // A locked or already-removed worktree must not fail the review.
        rmSync(path, { recursive: true, force: true });
      }
      await git(['worktree', 'prune'], mirror).catch(() => undefined);
    },
  };
}

/**
 * Files changed between two commits, read locally instead of over the API.
 * Two calls on purpose: passing `--numstat` and `--name-status` together makes
 * git emit only the name-status lines, silently zeroing every count.
 */
export async function changedFiles(mirror: string, base: string, head: string): Promise<
  { path: string; status: string; additions: number; deletions: number }[]
> {
  const byPath = new Map<string, { path: string; status: string; additions: number; deletions: number }>();
  const get = (p: string) => {
    let f = byPath.get(p);
    if (!f) byPath.set(p, (f = { path: p, status: 'M', additions: 0, deletions: 0 }));
    return f;
  };

  const stats = await git(['diff', '--numstat', '--no-renames', `${base}...${head}`], mirror);
  for (const line of stats.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const f = get(m[3]!);
    f.additions = m[1] === '-' ? 0 : Number(m[1]);
    f.deletions = m[2] === '-' ? 0 : Number(m[2]);
  }

  const names = await git(['diff', '--name-status', '--no-renames', `${base}...${head}`], mirror);
  for (const line of names.split('\n')) {
    const m = /^([AMDRTC])\d*\t(.+)$/.exec(line);
    if (!m) continue;
    get(m[2]!.split('\t').pop()!).status = m[1]!;
  }

  return [...byPath.values()];
}

/** The unified diff for one file, matching what the GitHub API would return. */
export async function filePatch(mirror: string, base: string, head: string, path: string): Promise<string> {
  const out = await git([
    'diff', '--unified=3', '--no-color', '--no-renames', `${base}...${head}`, '--', path,
  ], mirror);
  // Strip the file header: the reviewer only needs the hunks.
  const at = out.indexOf('\n@@');
  return at >= 0 ? out.slice(at + 1) : '';
}

export async function mergeBase(mirror: string, a: string, b: string): Promise<string> {
  return (await git(['merge-base', a, b], mirror)).trim();
}
