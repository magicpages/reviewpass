import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { matchesGlob, type Learning, type RecordedFinding } from './common.js';

/**
 * Learnings in a JSON file, with no native dependency.
 *
 * The SQLite store is the right shape for the daemon: thousands of rows, full
 * text search, a vector index. It is the wrong shape for a hosted runner, where
 * `better-sqlite3` needs a compiled `better_sqlite3.node` that no bundler can
 * inline — so the whole reviewer failed on a stock runner over a store that
 * typically holds a few hundred short strings.
 *
 * This is deliberately dumb: read the file, filter in memory, write it back.
 * At the scale this store actually reaches that is not worth optimising, and
 * being dumb is what makes it portable.
 *
 * **Persistence is an optimisation, never a correctness dependency.** Everything
 * needed to review *this* pull request already lives on the pull request: the
 * last reviewed commit, the findings already posted, and the replies rejecting
 * them are all read back from its comments. A cold store means the reviewer has
 * no memory of *other* pull requests — less informed, still correct. That is
 * the same bargain a dependency bot makes with its repository cache, and it is
 * why a missing file here is not an error.
 */

interface FileShape {
  version: 1;
  learnings: (Learning & { id: number; uses: number; createdAt: string })[];
  /** Fingerprints a maintainer rejected, by scope. Never raised again. */
  rejected: { scope: string; fingerprint: string }[];
  /** What was posted, so a later run can tell a repeat from a new finding. */
  findings: { scope: string; pr: number; fingerprint: string; posted: boolean }[];
}

const EMPTY: FileShape = { version: 1, learnings: [], rejected: [], findings: [] };

export class FileLearningStore {
  private data: FileShape;
  private dirty = false;

  constructor(private path: string) {
    this.data = FileLearningStore.read(path);
  }

  private static read(path: string): FileShape {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FileShape>;
      return {
        version: 1,
        learnings: raw.learnings ?? [],
        rejected: raw.rejected ?? [],
        findings: raw.findings ?? [],
      };
    } catch {
      // Absent, unreadable or malformed all mean the same thing: no memory yet.
      return { ...EMPTY };
    }
  }

  close(): void {
    if (!this.dirty) return;
    try {
      if (!existsSync(dirname(this.path))) mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
    } catch {
      // A read-only workspace is a normal hosted-runner condition. Losing the
      // write costs memory of this run, not the review it just produced.
    }
  }

  /**
   * Learnings that bear on this file, most specific first.
   *
   * Mirrors the SQL ordering: an exact path beats a directory prefix, which
   * beats a repository-wide rule, and a glob must actually match.
   */
  recall(scopes: string[], path: string, limit = 15): string[] {
    if (!scopes.length) return [];
    const dir = path.slice(0, path.lastIndexOf('/'));
    const scoped = new Set(scopes);

    const relevance = (l: Learning): number => {
      if (l.path && l.path === path) return 3;
      if (l.path && path.startsWith(l.path)) return 2;
      if (!l.glob) return 1;
      return 0;
    };

    return this.data.learnings
      .filter((l) => scoped.has(l.scope))
      .filter((l) => (l.glob ? matchesGlob(l.glob, path) : relevance(l) > 0))
      .sort((a, b) =>
        relevance(b) - relevance(a) ||
        (b.uses ?? 0) - (a.uses ?? 0) ||
        (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, limit)
      .map((l) => l.content);
  }

  rejectedFingerprints(scopes: string[]): Set<string> {
    const scoped = new Set(scopes);
    return new Set(this.data.rejected.filter((r) => scoped.has(r.scope)).map((r) => r.fingerprint));
  }

  seenOnPr(scope: string, pr: number): Set<string> {
    return new Set(
      this.data.findings
        .filter((f) => f.scope === scope && f.pr === pr && f.posted)
        .map((f) => f.fingerprint),
    );
  }

  recordFinding(f: RecordedFinding): number {
    this.data.findings.push({
      scope: f.scope, pr: f.pr, fingerprint: f.fingerprint, posted: f.posted,
    });
    this.dirty = true;
    return this.data.findings.length;
  }

  reject(scope: string, fingerprint: string): void {
    if (this.data.rejected.some((r) => r.scope === scope && r.fingerprint === fingerprint)) return;
    this.data.rejected.push({ scope, fingerprint });
    this.dirty = true;
  }

  /** Repository convention files, folded in so a cold store still knows the rules. */
  seedFromRules(scope: string, rules: { text: string; source: string; scope: string }[]): number {
    let added = 0;
    for (const r of rules) {
      if (this.data.learnings.some((l) => l.scope === scope && l.content === r.text)) continue;
      this.data.learnings.push({
        id: this.data.learnings.length + 1,
        scope,
        glob: r.scope === '*' ? undefined : r.scope,
        content: r.text,
        source: r.source,
        uses: 0,
        createdAt: new Date().toISOString(),
      });
      added++;
    }
    if (added) this.dirty = true;
    return added;
  }
}
