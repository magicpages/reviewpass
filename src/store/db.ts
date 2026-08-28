import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistent store, living on the inference host beside the runners.
 *
 * The earlier design shipped learnings in a JSON file restored from the Actions
 * cache. That was a workaround for an Action having nowhere to keep state — and
 * unnecessary here, because the runners and the model are the same machine. A
 * real database gives three things the cache could not:
 *
 *   - memory that genuinely spans repositories, which is how a reviewer's
 *     learnings behaved (116 of its learnings crossed from another repo);
 *   - a finding history to deduplicate against, so the same claim is not made
 *     twice on different PRs;
 *   - somewhere to keep embeddings for semantic recall.
 */

export type DB = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS learnings (
  id           INTEGER PRIMARY KEY,
  scope        TEXT NOT NULL,          -- 'owner/repo' or 'owner/*'
  path         TEXT,
  glob         TEXT,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_pr    INTEGER,
  created_at   TEXT NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scope, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_learn_scope ON learnings(scope);
CREATE INDEX IF NOT EXISTS idx_learn_path  ON learnings(path);

-- A claim the team rejected. Repeating it is worse than staying silent.
CREATE TABLE IF NOT EXISTS rejections (
  id          INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title       TEXT,
  path        TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(scope, fingerprint)
);

-- Everything ever posted, so a later review can tell a repeat from
-- something new and can report on its own accuracy.
CREATE TABLE IF NOT EXISTS findings (
  id           INTEGER PRIMARY KEY,
  scope        TEXT NOT NULL,
  pr           INTEGER NOT NULL,
  head_sha     TEXT,
  fingerprint  TEXT NOT NULL,
  path         TEXT NOT NULL,
  start_line   INTEGER,
  end_line     INTEGER,
  severity     TEXT,
  category     TEXT,
  title        TEXT NOT NULL,
  body         TEXT,
  had_suggestion INTEGER NOT NULL DEFAULT 0,
  verdict      TEXT,                  -- upheld | refuted by the verifier
  posted       INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT,                  -- implemented | rejected | ignored, learned later
  created_at   TEXT NOT NULL,
  UNIQUE(scope, pr, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_find_scope ON findings(scope, pr);
CREATE INDEX IF NOT EXISTS idx_find_fp    ON findings(fingerprint);

-- One row per review run, for cost and latency reporting.
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY,
  scope         TEXT NOT NULL,
  pr            INTEGER NOT NULL,
  head_sha      TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  files         INTEGER,
  candidates    INTEGER,
  posted        INTEGER,
  refuted       INTEGER,
  event         TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  seconds       REAL,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_scope ON runs(scope, pr);
`;

export const hashContent = (s: string) =>
  createHash('sha1').update(s.trim().toLowerCase()).digest('hex').slice(0, 16);

export function openStore(path: string): DB {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * Vector search is optional: sqlite-vec is a native extension and the daemon
 * must still work without it. Semantic dedup degrades to exact fingerprints.
 */
export function tryLoadVec(db: DB, dims: number): boolean {
  try {
    // Imported lazily so a missing optional dependency cannot break startup.
    const vec = require('sqlite-vec') as { load(d: DB): void };
    vec.load(db);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS finding_vectors USING vec0(
        finding_id INTEGER PRIMARY KEY,
        embedding  FLOAT[${dims}]
      );`);
    return true;
  } catch {
    return false;
  }
}
