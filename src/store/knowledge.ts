import { openStore, hashContent, type DB } from './db.js';

/**
 * The knowledge store: coding guidelines and accumulated review learnings,
 * indexed so the right handful surfaces for a given change.
 *
 * Design comes from two sources.
 *
 * **Two kinds of knowledge.** Durable review knowledge falls into two
 * shapes: 24% are `Applies to <glob> : <rule>` lifted from config, and the rest
 * are contextual — "In `apps/api/src/services/billing-api.ts` …". They carry 4.3
 * backticked tokens each, naming the exact files and symbols they concern. Those
 * tokens are the natural retrieval index, and they were being thrown away.
 *
 * **What the retrieval literature shows.** BM25 beats dense retrieval on code,
 * where exact identifiers matter, but hybrid beats either alone; fusing ranked
 * lists with Reciprocal Rank Fusion needs no score calibration. So this uses
 * FTS5's built-in BM25 over the text, plus exact structural matching on paths
 * and symbols, fused by RRF.
 *
 * Everything is local: no embedding service is needed at review time.
 */

export type KnowledgeKind = 'guideline' | 'learning';

export interface KnowledgeEntry {
  scope: string;              // 'owner/repo' or 'owner/*'
  kind: KnowledgeKind;
  content: string;
  /** Glob the rule is limited to, for `Applies to <glob>` guidelines. */
  glob?: string;
  /** File the learning came from. */
  sourceFile?: string;
  sourcePr?: number;
  source: string;
  /** How often the original reviewer recalled it — a usefulness prior. */
  weight?: number;
}

export interface Retrieved {
  content: string;
  kind: KnowledgeKind;
  why: string;                // which signal surfaced it, for debugging
  score: number;
  /** Set once a cross-encoder has scored it. */
  rerankScore?: number;
  // Retrieved values are passed to the reranker, which accepts any record whose
  // `content` it can read.
  [key: string]: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge (
  id           INTEGER PRIMARY KEY,
  scope        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  glob         TEXT,
  source_file  TEXT,
  source_pr    INTEGER,
  source       TEXT NOT NULL,
  weight       INTEGER NOT NULL DEFAULT 1,
  uses         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE(scope, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_k_scope ON knowledge(scope);

-- The backticked tokens a rule names: its retrieval anchors.
CREATE TABLE IF NOT EXISTS knowledge_anchors (
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  anchor       TEXT NOT NULL,
  anchor_type  TEXT NOT NULL      -- path | symbol | dir
);
CREATE INDEX IF NOT EXISTS idx_ka_anchor ON knowledge_anchors(anchor);
CREATE INDEX IF NOT EXISTS idx_ka_kid    ON knowledge_anchors(knowledge_id);

-- BM25 over the rule text plus its anchors.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  content, anchors, tokenize='porter unicode61'
);
`;

/** File extensions that make a token a real path rather than a property access. */
const CODE_EXT = /\.(m?[jt]sx?|cjs|cts|mts|json|jsonc|ya?ml|md|mdc|sql|sh|toml|css|scss|env|example)$/i;

/**
 * Backticked tokens, split into the kinds worth matching on.
 *
 * The distinction that matters: `apps/api/src/lib/env.ts` is a path, while
 * `process.env` and `console.log` are property accesses that merely look like
 * one. Treating the latter as paths produced anchors such as `dir:logger.inf`
 * and polluted the index.
 */
export function extractAnchors(text: string): { paths: string[]; symbols: string[]; dirs: string[] } {
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const dirs = new Set<string>();

  const isPath = (t: string) => CODE_EXT.test(t) && !/\s/.test(t);

  const addPath = (raw: string) => {
    const path = raw.replace(/^\.\//, '');
    paths.add(path);
    const cut = path.lastIndexOf('/');
    if (cut > 0) dirs.add(path.slice(0, cut));
  };

  for (const m of text.matchAll(/`([^`\n]{2,120})`/g)) {
    const tok = m[1]!.trim();

    // `file.ts:symbol` or `file.ts:12-20` — the path half is what we index.
    const qualified = /^([\w@./-]+):([A-Za-z_$][\w$]*)$/.exec(tok);
    if (qualified && isPath(qualified[1]!)) {
      addPath(qualified[1]!);
      symbols.add(qualified[2]!);
      continue;
    }

    if (isPath(tok)) { addPath(tok); continue; }

    // Everything else that looks like an identifier, including dotted calls
    // such as `logger.warn`, which are useful symbols but not paths.
    if (/^[A-Za-z_$][\w$.]{2,}$/.test(tok)) {
      const sym = tok.replace(/\(\)$/, '');
      symbols.add(sym);
      // Index the trailing member too: `logger.warn` should match `warn`.
      const dot = sym.lastIndexOf('.');
      if (dot > 0 && dot < sym.length - 1) symbols.add(sym.slice(dot + 1));
    }
  }

  // Paths named outside backticks still matter.
  for (const m of text.matchAll(/\b((?:apps|packages|src|lib|e2e|scripts|docs)\/[\w@./-]+)/g)) {
    if (isPath(m[1]!)) addPath(m[1]!);
  }

  return { paths: [...paths], symbols: [...symbols], dirs: [...dirs] };
}

/** `Applies to <glob> : <rule>` marks a path-scoped guideline. */
export function parseGuideline(content: string): { glob?: string; body: string } {
  const m = /^Applies to ([^:]+?)\s*:\s*([\s\S]+)$/.exec(content);
  if (!m) return { body: content };
  return { glob: m[1]!.trim(), body: m[2]!.trim() };
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close > i) {
        out += `(?:${glob.slice(i + 1, close).split(',').map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
        continue;
      }
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else { out += '.*'; }
      } else { out += '[^/]*'; }
    } else if (c === '?') { out += '[^/]'; }
    else if ('.+^$()|[]\\/'.includes(c)) { out += `\\${c}`; }
    else { out += c; }
  }
  try { return new RegExp(`^${out}$`); } catch { return /$^/; }
}

export interface Query {
  path: string;
  /** Identifiers the change introduces or touches. */
  symbols: string[];
  /** Local modules the change imports. */
  imports: string[];
  /** Free text to match on: the diff's added lines. */
  text: string;
}

/** Rank position -> RRF contribution. k=60 is the conventional constant. */
const rrf = (rank: number) => 1 / (60 + rank);

/**
 * How much a glob match is worth.
 *
 * `**' + '/*.{ts,tsx}` matches every TypeScript file in the repository and says
 * almost nothing about *this* one; `apps/api/src/scripts/**` says a great deal.
 * Scoring both at 1.0 let universal guidelines crowd out the specific learning
 * that actually applied. Specificity is approximated by the literal prefix
 * before the first wildcard.
 */
function globSpecificity(glob: string): number {
  const literal = glob.split(/[*{?]/)[0]!.replace(/\/$/, '');
  if (literal.length >= 20) return 1.2;
  if (literal.length >= 10) return 0.9;
  if (literal.length >= 4) return 0.6;
  return 0.3;                       // '**/*.ts' and friends
}

/** Identifiers and words worth matching on, lowercased. */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  // Split camelCase so `redactEmail` also matches `redact` and `email`.
  for (const raw of text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []) {
    const t = raw.toLowerCase();
    if (STOP.has(t)) continue;
    out.add(t);
    for (const part of raw.split(/(?=[A-Z])|_/)) {
      const p = part.toLowerCase();
      if (p.length > 3 && !STOP.has(p)) out.add(p);
    }
  }
  return out;
}

const STOP = new Set([
  'the','and','for','with','that','this','from','into','are','was','has','have','not','but','all',
  'const','let','var','function','return','import','export','await','async','type','interface',
  'string','number','boolean','void','null','undefined','true','false','new','class','extends',
  'if','else','try','catch','throw','while','case','switch','break','continue','default','public',
]);

/**
 * Overlap between a rule and a change, weighted by how rare each shared term is.
 *
 * Plain term counting does not discriminate: every rule shares `config`,
 * `import` and `value` with every diff, so a rule that also shares `dotenv` —
 * present in 3 of 1,085 rules — scored no better than one that shares nothing
 * meaningful. Weighting by inverse document frequency, as BM25 does, is what
 * separates the decisive term from the filler.
 */
function weightedOverlap(rule: Set<string>, change: Set<string>, idf: (t: string) => number): number {
  if (!rule.size || !change.size) return 0;

  // Sum the rarity of what they share, rather than the share of the rule that
  // matched. A long rule that happens to mention `dotenv` — which 3 of 1,085
  // rules mention — is exactly the one wanted for a diff that calls it, and
  // dividing by the rule's own length buried it.
  let shared = 0;
  for (const t of rule) if (change.has(t)) shared += idf(t);

  // Saturating: two or three genuinely rare terms in common is already a strong
  // signal, and piling on common ones should not keep raising the score.
  return shared / (shared + 8);
}

export class KnowledgeStore {
  private db: DB;

  constructor(path: string) {
    this.db = openStore(path);
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }
  get raw(): DB { return this.db; }

  add(e: KnowledgeEntry): boolean {
    const { glob, body } = parseGuideline(e.content);
    const kind: KnowledgeKind = glob ? 'guideline' : e.kind;
    const effectiveGlob = e.glob ?? glob;

    const info = this.db.prepare(`
      INSERT INTO knowledge(scope,kind,content,content_hash,glob,source_file,source_pr,source,weight,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scope, content_hash) DO NOTHING
    `).run(
      e.scope, kind, e.content, hashContent(e.content), effectiveGlob ?? null,
      e.sourceFile ?? null, e.sourcePr ?? null, e.source, e.weight ?? 1,
      new Date().toISOString(),
    );
    if (info.changes === 0) return false;

    const id = Number(info.lastInsertRowid);
    const anchors = extractAnchors(e.content);
    // The originating file is itself a strong anchor.
    if (e.sourceFile && !e.sourceFile.startsWith(':')) anchors.paths.push(e.sourceFile);

    const insAnchor = this.db.prepare(
      `INSERT INTO knowledge_anchors(knowledge_id, anchor, anchor_type) VALUES(?,?,?)`,
    );
    const seen = new Set<string>();
    for (const [type, list] of [['path', anchors.paths], ['symbol', anchors.symbols], ['dir', anchors.dirs]] as const) {
      for (const a of list) {
        const key = `${type}:${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insAnchor.run(id, a, type);
      }
    }

    this.db.prepare(`INSERT INTO knowledge_fts(rowid, content, anchors) VALUES(?,?,?)`)
      .run(id, body, [...anchors.paths, ...anchors.symbols].join(' '));
    return true;
  }

  /**
   * Guidelines that apply to this file, most specific first.
   *
   * These are kept apart from learnings rather than ranked against them,
   * mirroring how the source reviewer's own prompt was organised: a rule scoped
   * to `**' + '/*.ts` is not *less* true than a learning about a neighbouring
   * file, it is a different kind of statement. Ranking them together let a dozen
   * near-miss learnings from the same directory bury the guideline that applied.
   */
  guidelinesFor(scopes: string[], path: string, limit = 12): Retrieved[] {
    if (!scopes.length) return [];
    const holes = scopes.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, content, glob, weight FROM knowledge
       WHERE scope IN (${holes}) AND glob IS NOT NULL`,
    ).all(...scopes) as { id: number; content: string; glob: string; weight: number }[];

    return rows
      .filter((r) => globToRegExp(r.glob).test(path))
      .map((r) => ({
        content: r.content,
        kind: 'guideline' as const,
        why: `applies to ${r.glob}`,
        score: globSpecificity(r.glob) + Math.log10(1 + (r.weight ?? 1)) * 0.1,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Hybrid retrieval over contextual learnings: exact structural matches and
   * BM25 text matches, reranked against the diff. Guidelines are excluded — see
   * `guidelinesFor`.
   */
  retrieve(scopes: string[], q: Query, limit = 15): Retrieved[] {
    if (!scopes.length) return [];
    const holes = scopes.map(() => '?').join(',');
    const dir = q.path.slice(0, q.path.lastIndexOf('/'));
    const scored = new Map<number, { score: number; why: string[] }>();

    const bump = (id: number, score: number, why: string) => {
      const cur = scored.get(id);
      if (cur) { cur.score += score; if (!cur.why.includes(why)) cur.why.push(why); }
      else scored.set(id, { score, why: [why] });
    };

    // Exact anchor matches. Same-file is decisive; same-directory is weak on
    // purpose — a services directory holds dozens of files, and weighting it
    // highly flooded the results with near-misses from neighbouring modules.
    const anchorTargets: { value: string; weight: number; label: string }[] = [
      { value: q.path, weight: 3.0, label: 'same file' },
      ...(dir ? [{ value: dir, weight: 0.25, label: 'same directory' }] : []),
      ...q.imports.map((i) => ({ value: i, weight: 1.2, label: `imports ${i}` })),
      ...q.symbols.map((s) => ({ value: s, weight: 1.0, label: `symbol ${s}` })),
    ];
    const anchorStmt = this.db.prepare(`
      SELECT k.id FROM knowledge_anchors a
      JOIN knowledge k ON k.id = a.knowledge_id
      WHERE a.anchor = ? AND k.scope IN (${holes}) AND k.glob IS NULL`);
    for (const t of anchorTargets) {
      for (const row of anchorStmt.all(t.value, ...scopes) as { id: number }[]) {
        bump(row.id, t.weight, t.label);
      }
    }

    // 3. BM25 over the text. Strong on code, where identifiers carry the meaning.
    // Include the change's own vocabulary, not just where it lives. Reranking
    // can only reorder what retrieval returned, so a rule about `dotenv.config()`
    // has to be *retrievable* from a diff that calls it — matching on the file
    // path alone never surfaces it.
    // Sorting by length favoured long noise like `planGhostOwnerMemberships`
    // over short, rare, decisive tokens like `dotenv`. Rarity across the stored rules is
    // the property that matters, so prefer terms few rules mention.
    const diffVocab = this.rarestTerms([...tokenSet(q.text)].filter((t) => t.length > 4), 30);

    const terms = [...new Set([
      ...q.path.split(/[/.]/),
      ...q.symbols,
      ...q.imports.flatMap((i) => i.split(/[/.]/)),
      ...diffVocab,
    ])]
      .filter((t) => t.length > 3 && /^[A-Za-z][\w-]*$/.test(t))
      .slice(0, 48);

    if (terms.length) {
      const match = terms.map((t) => `"${t}"`).join(' OR ');
      try {
        const hits = this.db.prepare(`
          SELECT f.rowid AS id, rank
          FROM knowledge_fts f
          JOIN knowledge k ON k.id = f.rowid
          WHERE knowledge_fts MATCH ? AND k.scope IN (${holes}) AND k.glob IS NULL
          ORDER BY rank LIMIT 200`).all(match, ...scopes) as { id: number; rank: number }[];
        // A wide pool on purpose: the rerank below is what discriminates, and it
        // can only reorder what retrieval handed it.
        hits.forEach((h, i) => bump(h.id, rrf(i) * 12, 'text match'));
      } catch {
        // A malformed FTS query must not break the review.
      }
    }

    if (!scored.size) return [];

    const ids = [...scored.keys()];
    const rows = this.db.prepare(
      `SELECT id, content, kind, weight, uses FROM knowledge WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as { id: number; content: string; kind: KnowledgeKind; weight: number; uses: number }[];

    // Rerank against the change itself. Retrieval so far matched on where a rule
    // lives; this asks whether it is about what the diff actually does. In the
    // retrieval literature the rerank stage is the single largest gain, and here
    // it is what surfaces a rule about `dotenv.config()` for a diff that calls it.
    const diffTerms = tokenSet(q.text);
    const idf = this.idfLookup();

    const out = rows
      .map((r) => {
        const s = scored.get(r.id)!;
        // A rule the original reviewer leaned on repeatedly is worth more.
        const prior = 1 + Math.log10(1 + (r.weight ?? 1)) * 0.15;
        const overlap = diffTerms.size ? weightedOverlap(tokenSet(r.content), diffTerms, idf) : 0;
        const why = overlap > 0.08 ? [...s.why, `matches the change (${overlap.toFixed(2)})`] : s.why;
        return {
          content: r.content,
          kind: r.kind,
          why: why.join(', '),
          score: (s.score + overlap * 6.0) * prior,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const bumpUse = this.db.prepare(`UPDATE knowledge SET uses = uses + 1 WHERE id = ?`);
    this.db.transaction(() => {
      for (const r of rows.slice(0, limit)) bumpUse.run(r.id);
    })();

    return out;
  }

  private idfCache?: Map<string, number>;

  /**
   * Inverse document frequency over the rule corpus, built once per process.
   * Cheap: the corpus is ~1k short documents.
   */
  private idfLookup(): (term: string) => number {
    if (!this.idfCache) {
      const rows = this.db.prepare(`SELECT content FROM knowledge`).all() as { content: string }[];
      const df = new Map<string, number>();
      for (const r of rows) {
        for (const t of tokenSet(r.content)) df.set(t, (df.get(t) ?? 0) + 1);
      }
      const n = Math.max(1, rows.length);
      this.idfCache = new Map([...df].map(([t, c]) => [t, Math.log(1 + n / c)]));
    }
    const cache = this.idfCache;
    // An unseen term is maximally rare in this corpus.
    const maxIdf = Math.log(1 + cache.size);
    return (t: string) => cache.get(t) ?? maxIdf * 0.5;
  }

  /**
   * The terms fewest rules mention, which are the ones worth querying on.
   * A term present in half the corpus separates nothing.
   */
  private rarestTerms(terms: string[], limit: number): string[] {
    if (!terms.length) return [];
    const counted: { term: string; df: number }[] = [];
    const stmt = this.db.prepare(`SELECT count(*) c FROM knowledge_fts WHERE knowledge_fts MATCH ?`);
    for (const t of terms) {
      if (!/^[A-Za-z][\w-]*$/.test(t)) continue;
      try {
        counted.push({ term: t, df: (stmt.get(`"${t}"`) as { c: number }).c });
      } catch {
        // a term FTS cannot parse is simply skipped
      }
    }
    return counted
      .filter((c) => c.df > 0)
      .sort((a, b) => a.df - b.df)
      .slice(0, limit)
      .map((c) => c.term);
  }

  stats(): { total: number; guidelines: number; learnings: number; anchors: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      total: one(`SELECT count(*) c FROM knowledge`),
      guidelines: one(`SELECT count(*) c FROM knowledge WHERE kind='guideline'`),
      learnings: one(`SELECT count(*) c FROM knowledge WHERE kind='learning'`),
      anchors: one(`SELECT count(*) c FROM knowledge_anchors`),
    };
  }
}
