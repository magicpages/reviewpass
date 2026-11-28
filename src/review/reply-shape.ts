/**
 * The shapes an endpoint returns when it accepts the findings schema without
 * enforcing it.
 *
 * Ollama Cloud does exactly that: measured against `deepseek-v4.1-flash:1017`
 * on a real pull request, 13 of 13 files came back as a bare finding object
 * instead of `{ findings: [...] }`, or with `line`/`lines` instead of
 * `start_line`/`end_line`, and `settled_by` as the quote string rather than
 * `{ path, line, quote }`. Its native `format` field behaves the same way. The
 * pipeline rejected every reply, so the review found nothing and the check
 * failed.
 *
 * The content is placeable; only the keys differ. These helpers translate the
 * keys, never the claims: a finding still needs numeric lines, a title and a
 * body. A reply with nothing usable stays a failed pass rather than becoming a
 * clean file, which is the false all-clear this reviewer exists to prevent.
 */

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const numberAt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** `lines: "10-12"` or `lines: ["10", "12"]`, the two forms seen in replies. */
function rangeOf(f: Obj): { start: number; end: number } | undefined {
  const lines = f.lines;
  if (typeof lines === 'string') {
    const m = /^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$/.exec(lines);
    if (m) return { start: Number(m[1]), end: Number(m[2] ?? m[1]) };
  }
  if (Array.isArray(lines)) {
    const nums = lines.map((n) => numberAt(n) ?? Number(n)).filter(Number.isFinite);
    if (nums.length) return { start: nums[0]!, end: nums[nums.length - 1]! };
  }
  return undefined;
}

/**
 * The findings a reply carries, with the schema's key names, or `null` when it
 * carries none.
 *
 * Accepts the three shapes a model that ignored the wrapper produces: the
 * object the schema asks for, the bare array, and a single finding object.
 */
export function findingsOf(value: unknown, path: string): unknown[] | null {
  if (Array.isArray(value)) return value.map((f) => normalizeFinding(f, path));
  if (!isObject(value)) return null;
  if (Array.isArray(value.findings)) return value.findings.map((f) => normalizeFinding(f, path));
  if (isFindingLike(value)) return [normalizeFinding(value, path)];
  return null;
}

/** Whether an object is a finding rather than a wrapper, a summary or an error. */
function isFindingLike(value: Obj): boolean {
  return typeof value.title === 'string'
    || typeof value.body === 'string'
    || typeof value.start_line === 'number'
    || typeof value.line === 'number'
    || typeof value.lines === 'string';
}

/**
 * One finding (or sibling site) with the line and citation keys the pipeline
 * reads.
 *
 * `path` is the file under review; a reply that names its own file wins, which
 * is what the whole-change pass needs.
 */
export function normalizeFinding(value: unknown, path: string): unknown {
  if (!isObject(value)) return value;
  const f: Obj = { ...value };
  if (typeof f.path !== 'string' && typeof f.file === 'string') f.path = f.file;

  const range = rangeOf(f);
  const start = numberAt(f.start_line) ?? numberAt(f.line_start) ?? numberAt(f.line) ?? range?.start;
  const end = numberAt(f.end_line) ?? numberAt(f.line_end) ?? numberAt(f.line) ?? range?.end ?? start;
  if (start !== undefined) f.start_line = start;
  if (end !== undefined) f.end_line = end;

  const evidencePath = typeof f.path === 'string' ? f.path : path;
  const quote = typeof f.settled_by === 'string'
    ? f.settled_by
    : typeof f.evidence === 'string' ? f.evidence : undefined;
  if (quote?.trim() && !isObject(f.settled_by)) {
    f.settled_by = { path: evidencePath, line: start ?? 1, quote: quote.trim() };
  } else if (isObject(f.settled_by)) {
    const citation: Obj = { ...f.settled_by };
    if (typeof citation.path !== 'string') citation.path = evidencePath;
    if (numberAt(citation.line) === undefined) citation.line = start ?? 1;
    f.settled_by = citation;
  }

  if (Array.isArray(f.siblings)) {
    f.siblings = f.siblings.map((s) => normalizeFinding(s, evidencePath));
  }
  return f;
}
