import { openStore, hashContent, type DB } from './db.js';
import { matchesGlob, type Learning, type RecordedFinding } from './common.js';

// Re-exported so existing importers keep working; the definitions moved to a
// module that carries no native dependency with them.
export { scopesFor, matchesGlob } from './common.js';
export type { Learning, RecordedFinding } from './common.js';

/**
 * The learnings store.
 *
 * Most durable review knowledge originates from a human
 * correcting the bot — replying to a finding was the main way its behaviour
 * changed. Learnings also crossed repository boundaries, so `scope` carries an
 * org-wide tier (`owner/*`) alongside the per-repo one (`owner/repo`).
 */





export class LearningStore {
  private db: DB;

  constructor(path: string) {
    this.db = openStore(path);
  }

  close(): void {
    this.db.close();
  }

  get raw(): DB {
    return this.db;
  }

  add(l: Learning): boolean {
    const info = this.db.prepare(`
      INSERT INTO learnings(scope,path,glob,content,content_hash,source,source_pr,created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(scope, content_hash) DO NOTHING
    `).run(
      l.scope, l.path ?? null, l.glob ?? null, l.content, hashContent(l.content),
      l.source, l.sourcePr ?? null, new Date().toISOString(),
    );
    return info.changes > 0;
  }

  /**
   * Learnings that apply to a file, most specific first: one tied to this exact
   * path beats one scoped to its directory, which beats a general rule.
   */
  recall(scopes: string[], path: string, limit = 15): string[] {
    if (!scopes.length) return [];
    const holes = scopes.map(() => '?').join(',');
    const dir = path.slice(0, path.lastIndexOf('/'));
    const rows = this.db.prepare(`
      SELECT id, content, glob,
        CASE WHEN path = ?              THEN 3
             WHEN path IS NOT NULL AND ? LIKE path || '%' THEN 2
             WHEN glob IS NULL          THEN 1
             ELSE 0 END AS relevance
      FROM learnings
      WHERE scope IN (${holes})
      ORDER BY relevance DESC, uses DESC, created_at DESC
      LIMIT ?
    `).all(path, dir, ...scopes, limit * 3) as
      { id: number; content: string; glob: string | null; relevance: number }[];

    const useful = rows
      .filter((r) => (r.glob ? matchesGlob(r.glob, path) : r.relevance > 0))
      .slice(0, limit);

    if (useful.length) {
      const bump = this.db.prepare(`UPDATE learnings SET uses = uses + 1 WHERE id = ?`);
      this.db.transaction(() => { for (const r of useful) bump.run(r.id); })();
    }
    return useful.map((r) => r.content);
  }

  recordRejection(scope: string, fingerprint: string, title: string, path: string, reason: string): void {
    this.db.prepare(`
      INSERT INTO rejections(scope,fingerprint,title,path,reason,created_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope,fingerprint) DO UPDATE SET reason = excluded.reason
    `).run(scope, fingerprint, title, path, reason, new Date().toISOString());
  }

  /** Record that a maintainer argued a finding down, so it is never raised again. */
  reject(scope: string, fingerprint: string): void {
    // `created_at` is NOT NULL with no default, so it has to be supplied here.
    this.db.prepare(
      'INSERT OR IGNORE INTO rejections (scope, fingerprint, created_at) VALUES (?, ?, ?)',
    ).run(scope, fingerprint, new Date().toISOString());
  }

  rejectedFingerprints(scopes: string[]): Set<string> {
    if (!scopes.length) return new Set();
    const holes = scopes.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT fingerprint FROM rejections WHERE scope IN (${holes})`,
    ).all(...scopes) as { fingerprint: string }[];
    return new Set(rows.map((r) => r.fingerprint));
  }

  /** Fingerprints already raised on this PR, so a re-run does not repeat itself. */
  seenOnPr(scope: string, pr: number): Set<string> {
    const rows = this.db.prepare(
      `SELECT fingerprint FROM findings WHERE scope=? AND pr=? AND posted=1`,
    ).all(scope, pr) as { fingerprint: string }[];
    return new Set(rows.map((r) => r.fingerprint));
  }

  recordFinding(f: RecordedFinding): number {
    const info = this.db.prepare(`
      INSERT INTO findings(scope,pr,head_sha,fingerprint,path,start_line,end_line,severity,
        category,title,body,had_suggestion,verdict,posted,created_at)
      VALUES(@scope,@pr,@headSha,@fingerprint,@path,@startLine,@endLine,@severity,
        @category,@title,@body,@hadSuggestion,@verdict,@posted,@createdAt)
      ON CONFLICT(scope,pr,fingerprint) DO UPDATE SET
        posted = excluded.posted, verdict = excluded.verdict, head_sha = excluded.head_sha
    `).run({
      ...f,
      hadSuggestion: f.hadSuggestion ? 1 : 0,
      posted: f.posted ? 1 : 0,
      verdict: f.verdict ?? null,
      createdAt: new Date().toISOString(),
    });
    return Number(info.lastInsertRowid);
  }

  startRun(scope: string, pr: number, headSha: string): number {
    const info = this.db.prepare(
      `INSERT INTO runs(scope,pr,head_sha,started_at) VALUES(?,?,?,?)`,
    ).run(scope, pr, headSha, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  finishRun(id: number, r: {
    files: number; candidates: number; posted: number; refuted: number;
    event: string; promptTokens: number; completionTokens: number; seconds: number; error?: string;
  }): void {
    this.db.prepare(`
      UPDATE runs SET finished_at=?, files=?, candidates=?, posted=?, refuted=?, event=?,
        prompt_tokens=?, completion_tokens=?, seconds=?, error=? WHERE id=?
    `).run(new Date().toISOString(), r.files, r.candidates, r.posted, r.refuted, r.event,
      r.promptTokens, r.completionTokens, r.seconds, r.error ?? null, id);
  }

  /** Seed from the repository's own instruction files. */
  seedFromRules(scope: string, rules: { text: string; source: string; scope: string }[]): number {
    let added = 0;
    this.db.transaction(() => {
      for (const r of rules) {
        if (this.add({
          scope,
          glob: r.scope === '**' ? undefined : r.scope,
          content: r.text,
          source: r.source,
        })) added++;
      }
    })();
    return added;
  }

  stats(): { learnings: number; rejections: number; findings: number; runs: number } {
    const one = (t: string) => (this.db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
    return { learnings: one('learnings'), rejections: one('rejections'), findings: one('findings'), runs: one('runs') };
  }
}




