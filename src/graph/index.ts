import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSourceFiles, parsePath, type Declaration, type Reference, type ImportEdge } from './build.js';

/**
 * Queries over the symbol graph, shaped around what a reviewer needs.
 *
 * The reference reviewer derived ~89% of its findings from reading code rather
 * than from remembered rules, and it read well beyond the diff. Three questions
 * account for most of that reading:
 *
 *   - what is this thing I am changing, exactly?      → `define`
 *   - who depends on it, and will they still work?    → `callers`
 *   - what does it depend on that constrains it?      → `dependencies`
 *
 * Grep answers none of these cleanly: it cannot separate a declaration from a
 * mention, nor a call from a comment.
 */

export interface GraphIndex {
  root: string;
  files: number;
  byName: Map<string, Declaration[]>;
  refsByName: Map<string, Reference[]>;
  importsByPath: Map<string, ImportEdge[]>;
  /** Reverse import edges: which files import this one. */
  importedBy: Map<string, string[]>;
}

/** Build the whole index. ~2s for a 1,900-file monorepo. */
export async function buildIndex(root: string, log?: (m: string) => void): Promise<GraphIndex> {
  const started = Date.now();
  const files = listSourceFiles(root);
  const byName = new Map<string, Declaration[]>();
  const refsByName = new Map<string, Reference[]>();
  const importsByPath = new Map<string, ImportEdge[]>();
  const importedBy = new Map<string, string[]>();

  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  // Parsing is CPU-bound and independent per file; batching keeps memory flat.
  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    const graphs = await Promise.all(files.slice(i, i + BATCH).map((f) => parsePath(root, f)));
    for (const g of graphs) {
      if (!g) continue;
      for (const d of g.declarations) push(byName, d.name, d);
      for (const r of g.references) push(refsByName, r.name, r);
      if (g.imports.length) importsByPath.set(g.path, g.imports);
      for (const imp of g.imports) {
        const target = resolveSpecifier(root, g.path, imp.specifier);
        if (target) push(importedBy, target, g.path);
      }
    }
  }

  log?.(`Code graph: ${files.length} files, ${byName.size} symbols in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { root, files: files.length, byName, refsByName, importsByPath, importedBy };
}

/**
 * Resolve an import specifier to a repository path.
 * Relative imports are resolved directly; `@/x` aliases are matched against
 * known files by suffix, which is imprecise but needs no tsconfig parsing.
 */
function resolveSpecifier(root: string, from: string, spec: string): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('~/')) return null;
  const base = spec.startsWith('.')
    ? normalize(`${from.slice(0, from.lastIndexOf('/'))}/${spec}`)
    : spec.replace(/^[@~]\//, '');
  return base || null;
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export interface GraphContext {
  label: string;
  path: string;
  text: string;
}

/** The declaration of a symbol, with its source. */
export async function define(
  index: GraphIndex, name: string, excludePath?: string, maxLines = 60,
): Promise<GraphContext | null> {
  const decls = (index.byName.get(name) ?? [])
    .filter((d) => d.path !== excludePath)
    // An exported declaration is the one other code can be depending on.
    .sort((a, b) => Number(b.exported) - Number(a.exported));
  const d = decls[0];
  if (!d) return null;

  const text = await slice(index.root, d.path, d.line, Math.min(d.endLine, d.line + maxLines));
  if (!text) return null;
  return {
    label: `\`${name}\` is declared in \`${d.path}\` (${d.kind}, lines ${d.line}-${d.endLine})`,
    path: d.path,
    text,
  };
}

/**
 * Places that *call* a symbol, which is where a changed contract breaks.
 * Mentions are excluded: a type annotation is not a caller.
 */
export async function callers(
  index: GraphIndex, name: string, excludePath: string, limit = 4, window = 6,
): Promise<GraphContext[]> {
  const hits = (index.refsByName.get(name) ?? [])
    .filter((r) => r.kind === 'call' && r.path !== excludePath);

  // One site per file, so a single heavy consumer cannot crowd out the others.
  const seen = new Set<string>();
  const picked = hits.filter((r) => !seen.has(r.path) && seen.add(r.path)).slice(0, limit);

  const out: GraphContext[] = [];
  for (const r of picked) {
    const text = await slice(index.root, r.path, Math.max(1, r.line - window), r.line + window);
    if (text) out.push({ label: `\`${name}\` is called in \`${r.path}\`:${r.line}`, path: r.path, text });
  }
  return out;
}

/**
 * Other places that use the same API, richest usage first.
 *
 * This answers a different question from `callers`. `callers` looks *downstream*
 * — who breaks if I change this. `peers` looks *sideways* — how does the rest of
 * the codebase write this, so that what is missing here becomes visible.
 *
 * Every miss in the recall benchmark was an omission: a validation hook not
 * configured, a membership check not scoped, an assertion not made. A diff
 * cannot show an absence, and a model reading only the diff has nothing to
 * compare against. The established form lives in the sibling call sites, so
 * those are what get retrieved.
 *
 * Ranking is by `span` — the characters the whole expression covers — because
 * the peer that passes the options object is longer than the one that passes
 * nothing, and it is the one that reveals the gap. Same-package peers sort
 * first: conventions are local, and a rule followed next door is the one this
 * file was meant to follow.
 */
export async function peers(
  index: GraphIndex,
  name: string,
  origin: { path: string; shown?: { start: number; end: number }[] },
  limit = 3,
  window = 8,
): Promise<GraphContext[]> {
  const shown = origin.shown ?? [];
  const alreadyVisible = (line: number) => shown.some((w) => line >= w.start && line <= w.end);

  const hits = (index.refsByName.get(name) ?? []).filter((r) => {
    if (r.kind !== 'call' && r.kind !== 'construct' && r.kind !== 'key') return false;
    // Same-file peers are the strongest evidence there is - a sibling test in
    // the same suite, a sibling branch in the same function - so they are kept
    // rather than excluded. Only the lines already quoted are dropped, since
    // repeating them buys nothing.
    if (r.path === origin.path) return !alreadyVisible(r.line);
    return true;
  });
  if (!hits.length) return [];

  const pkg = packageOf(origin.path);
  const rank = (path: string) => (path === origin.path ? 2 : packageOf(path) === pkg ? 1 : 0);
  const ranked = [...hits].sort((a, b) => {
    const near = rank(b.path) - rank(a.path);
    return near !== 0 ? near : b.span - a.span;
  });

  // At most two sites from the file under review and one from anywhere else: a
  // single heavy consumer must not crowd out the variety, and variety is what
  // makes an omission stand out.
  const perFile = new Map<string, number>();
  const picked = ranked
    .filter((r) => {
      const cap = r.path === origin.path ? 2 : 1;
      const n = perFile.get(r.path) ?? 0;
      if (n >= cap) return false;
      perFile.set(r.path, n + 1);
      return true;
    })
    .slice(0, limit);

  const out: GraphContext[] = [];
  for (const r of picked) {
    const text = await slice(index.root, r.path, Math.max(1, r.line - 2), r.line + window);
    if (!text) continue;
    out.push({
      label:
        r.path === origin.path
          ? `How \`${name}\` is used elsewhere in this same file — line ${r.line}`
          : `How \`${name}\` is used elsewhere — \`${r.path}\`:${r.line}`,
      path: r.path,
      text,
    });
  }
  return out;
}

/**
 * Order candidate symbols by how much more the rest of the codebase does with
 * them than this change does.
 *
 * Distinctiveness is the wrong way to choose what to retrieve peers for. It
 * ranks `ObjectId` above `updateOne` because one is capitalised, when every
 * `ObjectId(x)` site in the repository is identical and therefore carries no
 * information, while `updateOne` sites differ sharply — some pass `$set`, some
 * only `$setOnInsert`, and that difference is the finding.
 *
 * So the signal is the gap: the longest peer call minus the longest call in the
 * changed lines. A positive gap means the codebase routinely passes something
 * here that this change does not, which is precisely the evidence an omission
 * needs. Symbols used identically everywhere score zero and drop out.
 */
export function rankByUsageGap(
  index: GraphIndex,
  path: string,
  changed: { start: number; end: number }[],
  candidates: string[],
): string[] {
  const inChange = (line: number) => changed.some((w) => line >= w.start && line <= w.end);

  const scored: { name: string; gap: number }[] = [];
  for (const name of candidates) {
    const refs = (index.refsByName.get(name) ?? [])
      .filter((r) => r.kind === 'call' || r.kind === 'construct' || r.kind === 'key');

    // Sibling uses in the file under review are the convention for that file
    // whatever the symbol's repository-wide frequency: the other `vi.mock`
    // calls in a test suite are how that suite mocks, and `vi.mock` being
    // common everywhere does not make them less binding here.
    const nearby = refs.some((r) => r.path === path && !inChange(r.line));

    // Otherwise convention lives in the middle of the frequency range. A symbol
    // used twice has no established form; one used four hundred times is
    // plumbing (`exec`, `trim`, `config`) whose longest call site anywhere is
    // long for incidental reasons - enough to win on span alone, and worthless.
    if (!nearby && (refs.length < 3 || refs.length > 60)) continue;

    let local = 0;
    let peer = 0;
    for (const r of refs) {
      if (r.path === path && inChange(r.line)) local = Math.max(local, r.span);
      else peer = Math.max(peer, r.span);
    }
    if (peer <= local) continue;

    // Relative, not absolute: "the peers do twice what this does" is a claim
    // about form, while "the peers do 400 more characters" is a claim about the
    // length of somebody's argument list.
    // An operator key carries the semantics of the operation - `$set` against
    // `$setOnInsert` is the difference between updating a row and ignoring it -
    // so it outranks an ordinary call whose peers merely happen to be longer.
    const isOperator = name.startsWith('$');
    scored.push({
      name,
      gap: (peer / Math.max(local, 24)) * (nearby ? 3 : 1) * (isOperator ? 2.5 : 1),
    });
  }

  scored.sort((a, b) => b.gap - a.gap);
  return scored.map((s) => s.name);
}

/**
 * The unit a path belongs to, for locality comparisons.
 *
 * Used only to ask "is this peer from the same part of the codebase?", so it
 * needs to be stable rather than exactly right. Taking the first two segments
 * assumed a monorepo laid out as `apps/x` — on a flat repository every path
 * collapsed to the same value and locality ranking silently became a no-op.
 *
 * The parent directory is the honest default: in a monorepo the interesting
 * boundary is usually deeper than the workspace root anyway, and on a flat
 * repository sibling files still group together.
 */
function packageOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '' : path.slice(0, at);
}

/** Local modules a file imports, with the declarations it takes from them. */
export async function dependencies(
  index: GraphIndex, path: string, names: string[], limit = 4,
): Promise<GraphContext[]> {
  const out: GraphContext[] = [];
  for (const name of names.slice(0, limit * 2)) {
    if (out.length >= limit) break;
    const d = await define(index, name, path, 40);
    if (d) out.push(d);
  }
  return out;
}

/** Files that import this one — the blast radius of changing its exports. */
export function dependents(index: GraphIndex, path: string, limit = 8): string[] {
  const stem = path.replace(/\.[^.]+$/, '');
  const direct = index.importedBy.get(stem) ?? [];
  if (direct.length) return direct.slice(0, limit);

  // Alias imports resolve by suffix, so fall back to matching the tail.
  const out: string[] = [];
  for (const [target, importers] of index.importedBy) {
    if (stem.endsWith(target) || target.endsWith(stem.split('/').slice(-2).join('/'))) {
      out.push(...importers);
      if (out.length >= limit) break;
    }
  }
  return [...new Set(out)].slice(0, limit);
}

async function slice(root: string, path: string, from: number, to: number): Promise<string> {
  try {
    const lines = (await readFile(join(root, path), 'utf8')).split('\n');
    return lines
      .slice(Math.max(0, from - 1), to)
      .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
      .join('\n');
  } catch {
    return '';
  }
}

export { listSourceFiles } from './build.js';
export type { Declaration, Reference, ImportEdge } from './build.js';
