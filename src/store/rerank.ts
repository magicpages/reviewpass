/**
 * Cross-encoder reranking.
 *
 * Lexical retrieval reliably gets the right rule into the candidate pool but
 * cannot rank it first: hand-tuned scoring put a rule about `dotenv.config()`
 * at rank 14 for a diff that calls `dotenv.config()`, because every rule shares
 * words like `config` and `import` with every diff. A cross-encoder reads the
 * query and the document *together* rather than comparing independent
 * representations, which is why it separates them so sharply — in a direct test
 * the relevant rule scored +3.3 and an irrelevant one −10.9.
 *
 * This is the stage the retrieval literature credits with the largest single
 * gain (Recall@5 0.816 against 0.695 for fused retrieval alone).
 */

export interface RerankCandidate {
  content: string;
  [key: string]: unknown;
}

export interface RerankOptions {
  endpoint: string;
  model?: string;
  /** Documents to score. Beyond a few dozen the latency stops paying for itself. */
  topN?: number;
  timeoutMs?: number;
  /** Surfaced so a silent fallback is visible in logs rather than mysterious. */
  onError?: (message: string) => void;
}

interface RerankResponse {
  results: { index: number; relevance_score: number }[];
}

/**
 * Score candidates against the query, returning them in the reranker's order.
 * Falls back to the input order when the service is unavailable — a review must
 * not fail because a ranking refinement is down.
 */
export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  opts: RerankOptions,
): Promise<(T & { rerankScore?: number })[]> {
  if (candidates.length <= 1) return candidates;

  const onError = opts.onError;
  const pool = candidates.slice(0, opts.topN ?? 40);
  const rest = candidates.slice(pool.length);
  const scores = await scoreChunk(query, pool, opts);
  if (!scores) return candidates;

  const ranked = pool
    .map((c, i) => ({ ...c, rerankScore: scores[i] ?? -Infinity }))
    .sort((a, b) => b.rerankScore - a.rerankScore);
  return [...ranked, ...rest];
}

/**
 * Rerank against the whole change rather than its first few thousand characters.
 *
 * A single truncated query loses whatever sits further down the diff — a rule
 * about redacting logged values cannot be matched when the `logger` call was cut
 * off. So the change is split into windows, every candidate is scored against
 * each, and each keeps its best score: a rule that bears on *any* part of the
 * change surfaces.
 */
export async function rerankOverChange<T extends RerankCandidate>(
  path: string,
  addedLines: string,
  candidates: T[],
  opts: RerankOptions & { chunkChars?: number; maxChunks?: number },
): Promise<(T & { rerankScore?: number })[]> {
  if (candidates.length <= 1) return candidates;

  const pool = candidates.slice(0, opts.topN ?? 120);
  const rest = candidates.slice(pool.length);
  const chunks = splitChange(addedLines, opts.chunkChars ?? 2_400, opts.maxChunks ?? 5);
  if (!chunks.length) return candidates;

  const best = new Array<number>(pool.length).fill(-Infinity);
  let anySucceeded = false;

  for (const chunk of chunks) {
    const scores = await scoreChunk(`File: ${path}\n\nChange:\n${chunk}`, pool, opts);
    if (!scores) continue;
    anySucceeded = true;
    for (let i = 0; i < pool.length; i++) {
      const v = scores[i];
      if (v !== undefined && v > best[i]!) best[i] = v;
    }
  }
  if (!anySucceeded) return candidates;

  const ranked = pool
    .map((c, i) => ({ ...c, rerankScore: best[i]! }))
    .sort((a, b) => b.rerankScore - a.rerankScore);
  return [...ranked, ...rest];
}

/** Score one query against every candidate. Returns scores in candidate order. */
async function scoreChunk<T extends RerankCandidate>(
  query: string,
  pool: T[],
  opts: RerankOptions,
): Promise<number[] | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${opts.endpoint.replace(/\/$/, '')}/v1/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? 'bge-reranker',
        // Every (query, document) pair must fit the reranker's slot, which is a
        // few thousand tokens - far smaller than the review model's.
        query: truncate(query, 3_500),
        documents: pool.map((c) => truncate(c.content, 900)),
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      opts.onError?.(`rerank ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as RerankResponse;
    if (!Array.isArray(json.results)) return null;

    const out = new Array<number>(pool.length).fill(-Infinity);
    for (const r of json.results) {
      if (r.index >= 0 && r.index < pool.length) out[r.index] = r.relevance_score;
    }
    return out;
  } catch (err) {
    opts.onError?.(`rerank failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Split the added lines into windows, preferring line boundaries. */
function splitChange(added: string, chunkChars: number, maxChunks: number): string[] {
  const text = added.trim();
  if (!text) return [];
  if (text.length <= chunkChars) return [text];

  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > chunkChars && cur) {
      chunks.push(cur);
      if (chunks.length >= maxChunks) return chunks;
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur && chunks.length < maxChunks) chunks.push(cur);
  return chunks;
}

/**
 * What the reranker is asked about. The diff is the query: the question is
 * "which of these rules bears on this change?", so the change itself has to be
 * the thing rules are scored against.
 */
export function buildRerankQuery(path: string, addedLines: string): string {
  return `File: ${path}\n\nChange:\n${addedLines}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}
