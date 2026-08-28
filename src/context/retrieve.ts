import { readFile } from 'node:fs/promises';
import { parseJsonc } from './jsonc.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { searchRepo, findByName, renderMatches, searchBackend } from './search.js';
import { define, callers, peers, rankByUsageGap, dependents, type GraphIndex } from '../graph/index.js';

/**
 * Retrieval.
 *
 * The shape that works: wide search, narrow reads. Cast a broad pattern, take
 * small windows around the hits, then read the interesting ones in full. Most of
 * the code that decides whether a change is correct is not in the diff, so
 * reaching outside it is the point rather than a fallback.
 *
 * The single most valuable block here is the first one: the real file around
 * each hunk. A diff alone hides the function it sits in, and most false
 * positives come from the model guessing at code it cannot see.
 */

export interface Retrieved {
  label: string;
  path?: string;
  text: string;
}

/** Lines of the real file to show around each changed hunk. */
const WINDOW = 30;

export async function describeBackend(root: string): Promise<string> {
  return searchBackend(root);
}

/** Hunk positions in the new file, from the diff headers. */
export function hunkRanges(patch: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const len = m[2] ? Number(m[2]) : 1;
    out.push({ start, end: start + len });
  }
  return out;
}

/** Merge overlapping windows so the same code is not sent twice. */
function mergeWindows(ranges: { start: number; end: number }[], pad: number) {
  const padded = ranges
    .map((r) => ({ start: Math.max(1, r.start - pad), end: r.end + pad }))
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of padded) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 5) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

async function readLines(root: string, path: string): Promise<string[] | null> {
  try {
    return (await readFile(join(root, path), 'utf8')).split('\n');
  } catch {
    return null;
  }
}

/** The file as it stands, around the changes, with line numbers. */
export async function fileWindows(root: string, path: string, patch: string): Promise<string> {
  const lines = await readLines(root, path);
  if (!lines) return '';
  const windows = mergeWindows(hunkRanges(patch), WINDOW);
  if (!windows.length) return '';

  const parts: string[] = [];
  for (const w of windows) {
    const from = Math.max(1, w.start);
    const to = Math.min(lines.length, w.end);
    const body = lines
      .slice(from - 1, to)
      .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
      .join('\n');
    parts.push(body);
  }
  return parts.join('\n     ⋮\n');
}

export async function readFileHead(root: string, path: string, maxLines = 120): Promise<string> {
  const lines = await readLines(root, path);
  if (!lines) return '';
  return lines.slice(0, maxLines).map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join('\n');
}

/** Identifiers the diff introduces — the seeds for caller lookups. */
export function symbolsInPatch(patch: string): string[] {
  const added = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');

  const names = new Set<string>();
  const patterns = [
    /\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/g,
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g,
    /\b([A-Za-z_$][\w$]{3,})\s*\(/g,
  ];
  const COMMON = /^(this|self|true|false|null|void|type|const|from|then|catch|async|await|return|require|expect|describe|console|Object|Array|String|Number|Promise|JSON|Error|Math|Date|test|it|if|for|while|switch|typeof|import|export)$/;
  for (const re of patterns) {
    for (const m of added.matchAll(re)) {
      const n = m[1]!;
      if (n.length >= 4 && !COMMON.test(n)) names.add(n);
    }
  }
  return [...names].slice(0, 8);
}

/**
 * APIs the added lines *use*, most distinctive first.
 *
 * `symbolsInPatch` collects what the change declares, which is what callers and
 * definitions hang off. Finding an omission needs the opposite: the APIs the
 * change consumes, so the established way of consuming them can be shown beside
 * it. `new OpenAPIHono()` is the seed that retrieves the sub-app next door which
 * passes `defaultHook`.
 *
 * This is a *candidate* pass and is deliberately wide. Which of these is worth
 * retrieving peers for is not a question the text can answer — `ObjectId` looks
 * more distinctive than `updateOne` and is worth far less — so the ordering is
 * left to `rankByUsageGap`, which can see how the whole repository uses each.
 */
export function apisUsedInPatch(patch: string, limit = 24): string[] {
  const added = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');

  // Anything the patch *declares* has no informative peers - those would be its
  // own call sites, which `callers` already covers. This must not reuse
  // `symbolsInPatch`, which also collects called names: subtracting that set
  // removes every seed and leaves nothing to retrieve.
  const declared = new Set<string>();
  for (const re of [
    /\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/g,
  ]) {
    for (const m of added.matchAll(re)) declared.add(m[1]!);
  }

  const TOO_COMMON = new RegExp(
    '^(if|for|while|switch|catch|return|typeof|await|async|function|const|let|var|new|this|self' +
      '|map|filter|find|push|join|split|slice|test|log|error|warn|info|debug|then|toString|keys' +
      '|values|entries|length|name|type|data|value|item|index|props|state|set|get|has|add|delete' +
      '|expect|describe|beforeEach|afterEach|beforeAll|afterAll|require|String|Number|Boolean' +
      '|Array|Object|JSON|Math|Date|Promise|Error|console)$',
  );

  const found = new Set<string>();
  const note = (name: string) => {
    // `$set` is four characters and decisive; a bare three-letter key is not.
    const floor = name.startsWith('$') ? 3 : 4;
    if (!name || name.length < floor || TOO_COMMON.test(name) || declared.has(name)) return;
    found.add(name);
  };

  // Order matters: `found` keeps insertion order and the list is capped, so the
  // most informative kinds are collected first. Putting keys last cost a whole
  // benchmark case - `$setOnInsert` fell past the cap behind forty ordinary
  // calls, and the finding about it could never be reached.

  // 1. Operator-style keys (`$set`, `$inc`, `$addToSet`). A query DSL is
  //    addressed entirely this way, and the operator IS the semantics.
  for (const m of added.matchAll(/(?:^|[{,\s])(\$[A-Za-z_][\w$]{1,})\s*:/gm)) note(m[1]!);
  // 2. A constructed type: configuration lives in its options object.
  for (const m of added.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) note(m[1]!);
  // 3. Method calls carry the conventions of the object they belong to.
  for (const m of added.matchAll(/\.([A-Za-z_$][\w$]{3,})\s*\(/g)) note(m[1]!);
  // 4. Plain calls.
  for (const m of added.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]{3,})\s*\(/gm)) note(m[1]!);
  // 5. Ordinary object keys, which still address a large part of an API surface
  //    (`{ upsert: true }`, `{ defaultHook }`). Keys naming nothing the graph
  //    knows match no peers and fall out, so this can afford to be generous.
  for (const m of added.matchAll(/(?:^|[{,\s])([A-Za-z_][\w$]{2,})\s*:/gm)) note(m[1]!);

  return [...found].slice(0, limit);
}

/** Resolve `@/x`, `~/x` and relative imports using the nearest tsconfig paths. */
function resolveImport(root: string, from: string, spec: string): string | null {
  const candidates: string[] = [];

  if (spec.startsWith('.')) {
    candidates.push(normalize(`${dirname(from)}/${spec}`));
  } else {
    // Alias imports resolve against the owning package, not the repo root.
    const aliasBase = tsconfigAliasBase(root, from);
    const stripped = spec.replace(/^[@~]\//, '');
    for (const base of aliasBase) candidates.push(normalize(`${base}/${stripped}`));
  }

  for (const base of candidates) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '']) {
      if (existsSync(join(root, `${base}${ext}`))) return `${base}${ext}`;
    }
  }
  return null;
}

const aliasCache = new Map<string, string[]>();

/** Directories an `@/` alias could point at, nearest package first. */
export function tsconfigAliasBase(root: string, from: string): string[] {
  const pkgDir = nearestPackageDir(root, from);
  const cached = aliasCache.get(pkgDir);
  if (cached) return cached;

  const bases = new Set<string>();
  const tsconfig = join(root, pkgDir, 'tsconfig.json');
  if (existsSync(tsconfig)) {
    try {
      // Parsed with a scanner rather than a regex: a path alias like `@/lib/*`
      // contains a slash then an asterisk, so regex comment-stripping treated
      // it as the start of a block comment and destroyed the file. Every alias
      // in this repository was being silently discarded.
      const cfg = parseJsonc<{
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      }>(readFileSync(tsconfig, 'utf8'));
      if (!cfg) throw new Error('unparseable tsconfig');
      const baseUrl = cfg.compilerOptions?.baseUrl ?? '.';
      for (const targets of Object.values(cfg.compilerOptions?.paths ?? {})) {
        for (const t of targets) {
          bases.add(normalize(`${pkgDir}/${baseUrl}/${t.replace(/\/?\*+$/, '')}`));
        }
      }
    } catch {
      // fall through to the conventional guesses
    }
  }
  bases.add(normalize(`${pkgDir}/src`));
  bases.add(pkgDir);

  const list = [...bases];
  aliasCache.set(pkgDir, list);
  return list;
}

function nearestPackageDir(root: string, from: string): string {
  let dir = dirname(from);
  while (dir && dir !== '.' && dir !== '/') {
    if (existsSync(join(root, dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return '.';
}

/**
 * Local modules this file depends on.
 *
 * Reads the whole file, not only the diff. Taking imports from the patch alone
 * meant a change that touched no import line retrieved nothing: a change to the
 * styling of a page never pulled in the components that page renders, so the
 * convention they follow was invisible and a divergence from it went unreported.
 * What a file imports is a property of the file, not of the lines that changed.
 */
function importedSpecs(patch: string, fileText?: string, hunks?: { start: number; end: number }[]): string[] {
  const seen = new Map<string, string[]>();          // specifier -> bound names
  const add = (source: string) => {
    for (const m of source.matchAll(/import\s+([\s\S]*?)\s*from\s+['"]([^'"]+)['"]/g)) {
      const names = [...m[1]!.matchAll(/([A-Za-z_$][\w$]*)/g)].map((n) => n[1]!);
      if (!seen.has(m[2]!)) seen.set(m[2]!, names);
    }
    for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!seen.has(m[1]!)) seen.set(m[1]!, []);
    }
  };
  add(patch);
  if (fileText) add(fileText);

  const local = [...seen].filter(([spec]) =>
    spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/'));

  // Rank by whether the imported binding is used near the change. A page that
  // renders eight components imports its router root first and the components
  // last, so file order retrieves exactly the wrong ones - and the convention a
  // styling change should have matched lives in the components it renders, not
  // in the router.
  if (fileText && hunks?.length) {
    const lines = fileText.split('\n');
    const near = (name: string) => hunks.some((h) => {
      const from = Math.max(0, h.start - 40);
      const to = Math.min(lines.length, h.end + 40);
      return lines.slice(from, to).some((l) => new RegExp(`\\b${name}\\b`).test(l));
    });
    local.sort((a, b) => Number(b[1].some(near)) - Number(a[1].some(near)));
  }

  return local.map(([spec]) => spec).slice(0, 10);
}

/**
 * The part of a dependency that corresponds to what changed.
 *
 * Reading the first ninety lines of an imported file is the wrong shape: a
 * component keeps its imports and hooks at the top and its markup below, so the
 * convention a change should have matched sits past the cut. A styling change
 * retrieved the component it renders and still could not see that the component
 * used the older value, because that line was number 110.
 *
 * So the added lines are mined for distinctive tokens, and the dependency is
 * shown where it uses the same ones. Hyphenated tokens also match on their
 * family - changing `rounded-3xl` finds `rounded-2xl` - which is what makes an
 * inconsistency visible rather than merely adjacent.
 */
async function correspondingWindow(
  root: string,
  path: string,
  added: string,
  removed: string,
  window = 12,
): Promise<string> {
  const lines = await readLines(root, path);
  if (!lines) return '';

  const words = (src: string) => new Set([...src.matchAll(/[A-Za-z][\w-]{4,}/g)].map((m) => m[0]!));
  const inAdded = words(added);
  const inRemoved = words(removed);

  // What the change actually replaced. A token present on both sides is
  // scenery; one that only appears on the removed side is the old form, and a
  // neighbour that has not been migrated still contains it. Searching for that
  // first is what turns "here is a related file" into "here is the same thing
  // still done the old way".
  const replaced = [...inRemoved].filter((t) => !inAdded.has(t));
  const introduced = [...inAdded].filter((t) => !inRemoved.has(t));

  // Families too, so a change from one variant to another finds any variant.
  const family = (t: string) => { const d = t.lastIndexOf('-'); return d > 2 ? t.slice(0, d + 1) : null; };
  const ordered = [
    ...replaced,
    ...introduced,
    ...replaced.map(family).filter((t): t is string => Boolean(t)),
    ...introduced.map(family).filter((t): t is string => Boolean(t)),
  ];
  if (!ordered.length) return '';

  for (const token of ordered) {
    const hit = lines.findIndex((l) => l.includes(token));
    if (hit < 0) continue;
    const from = Math.max(1, hit + 1 - window);
    const to = Math.min(lines.length, hit + 1 + window);
    return lines
      .slice(from - 1, to)
      .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
      .join('\n');
  }
  return '';
}

/** Test files that cover this source file, wherever they live in the tree. */
async function counterparts(root: string, path: string): Promise<string[]> {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const stem = base.replace(/\.(m?[jt]sx?|cjs|cts|mts)$/, '');
  const isTest = /\.(test|spec)\./.test(base);

  const names = isTest
    ? [stem.replace(/\.(test|spec)$/, '')].flatMap((s) => ['ts', 'tsx', 'js', 'jsx'].map((e) => `${s}.${e}`))
    : ['test', 'spec'].flatMap((k) => ['ts', 'tsx', 'js', 'jsx'].map((e) => `${stem}.${k}.${e}`));

  return (await findByName(root, names, 3)).filter((p) => p !== path);
}

/**
 * How much surrounding code one file's review is allowed.
 *
 * Lives here, and is called by both the pipeline and the benchmark harness,
 * because it was written twice and drifted: the harness kept an older floor and
 * no notion of how many modules the file depends on, so a benchmark run was
 * quietly measuring a configuration that no longer shipped.
 *
 * Two ceilings, smaller wins. The ratio keeps context proportional to the
 * change. The floor rises with the number of local modules the file imports,
 * because a small change in a file with many collaborators needs to see them —
 * they carry the convention it is supposed to match.
 */
export function contextBudgetFor(opts: {
  patch: string;
  fileText?: string;
  contextRatio: number;
  ceiling: number;
}): number {
  const localImports = opts.fileText
    ? new Set([...opts.fileText.matchAll(/from\s+['"]([.@~][^'"]*)['"]/g)].map((m) => m[1])).size
    : 0;
  const floor = Math.min(24_000, 8_000 + 1_500 * Math.min(localImports, 8));
  if (!opts.contextRatio) return opts.ceiling;
  return Math.max(floor, Math.min(opts.ceiling, Math.floor(opts.patch.length * opts.contextRatio)));
}

export interface ContextRequest {
  root: string;
  path: string;
  patch: string;
  budgetChars: number;
  /** The anchored file in full, when the caller has already read it. */
  fileText?: string;
  /**
   * Symbol graph for the repository. When present it replaces the grep-based
   * caller search: grep cannot tell a call from a comment, nor a declaration
   * from a mention, and the reviewer needs exactly that distinction.
   */
  graph?: GraphIndex;
}

export async function gatherContext(req: ContextRequest): Promise<Retrieved[]> {
  const { root, path, patch, budgetChars } = req;
  const out: Retrieved[] = [];
  let used = 0;

  const push = (r: Retrieved | null): boolean => {
    if (!r || !r.text.trim()) return false;
    // The first block is the file around the change and is worth most of the
    // budget; only clamp it if it would consume the lot.
    const cap = out.length === 0 ? Math.floor(budgetChars * 0.75) : Math.floor(budgetChars * 0.25);
    const text = r.text.length > cap ? `${r.text.slice(0, cap)}\n… (truncated)` : r.text;
    if (used + text.length > budgetChars) return false;
    used += text.length;
    out.push({ ...r, text });
    return true;
  };

  // 1. The change in its real surroundings. Highest value, so it goes first.
  push({
    label: `\`${path}\` as it now stands, around the changes`,
    path,
    text: await fileWindows(root, path, patch),
  });

  // 2. How the rest of the repository uses the APIs this change consumes.
  // Placed second deliberately: an omission is only visible against the
  // established form, so this must be funded before the lower-value blocks
  // rather than picking up whatever budget survives them.
  if (req.graph) {
    // The hunk windows are already quoted above, so peers must not repeat them.
    const quoted = mergeWindows(hunkRanges(patch), WINDOW);
    const seeds = rankByUsageGap(req.graph, path, hunkRanges(patch), apisUsedInPatch(patch));
    // One peer per seed rather than two: with a fixed budget, breadth across
    // different APIs beats depth on the first one. Two seeds taking two slots
    // each meant a Mongo operator ranked fourth was never reached at all.
    let shown = 0;
    for (const api of seeds) {
      if (shown >= 5) break;
      for (const p of await peers(req.graph, api, { path, shown: quoted }, 1)) {
        if (!push({ label: p.label, path: p.path, text: p.text })) break;
        shown++;
      }
    }
  }

  // 3. The test that covers this file, or the source a test covers.
  for (const c of await counterparts(root, path)) {
    push({ label: `Counterpart \`${c}\``, path: c, text: await readFileHead(root, c, 150) });
  }

  // 4. Local imports the change relies on — the contracts it must honour.
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const removed = patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).join('\n');
  for (const spec of importedSpecs(patch, req.fileText, hunkRanges(patch))) {
    const resolved = resolveImport(root, path, spec);
    if (!resolved || resolved === path) continue;
    // Where the dependency does the same thing, if it does; otherwise its head.
    const corresponding = await correspondingWindow(root, resolved, added, removed);
    push({
      label: corresponding
        ? `Imported \`${resolved}\` — where it does the same thing`
        : `Imported \`${resolved}\``,
      path: resolved,
      text: corresponding || await readFileHead(root, resolved, 90),
    });
  }

  const symbols = symbolsInPatch(patch);

  if (req.graph) {
    // 4a. Who calls what this change touches — where a broken contract shows up.
    for (const sym of symbols.slice(0, 5)) {
      for (const c of await callers(req.graph, sym, path, 2)) {
        if (!push({ label: c.label, path: c.path, text: c.text })) break;
      }
    }

    // 4b. Declarations the change relies on but does not contain.
    for (const sym of symbols.slice(0, 6)) {
      const d = await define(req.graph, sym, path, 40);
      if (d && !push({ label: d.label, path: d.path, text: d.text })) break;
    }

    // 4c. What depends on this file at all: the blast radius of changing it.
    const affected = dependents(req.graph, path, 8);
    if (affected.length) {
      push({
        label: `Files importing \`${path}\``,
        text: affected.map((p) => `  ${p}`).join('\n'),
      });
    }
  }

  // Whatever the graph found, it is bounded by per-query caps rather than by the
  // budget, and it routinely stops with most of the budget unspent — on one
  // measured file, 13k of 32k chars. Unspent budget is context the reviewer
  // could have had, so the grep sweep tops it up. It is less precise than the
  // graph, which is why it goes last, but "less precise" beats "absent": the
  // blocks it adds here are the ones that were missing when a finding about a
  // subscription being overwritten had no view of the other `subscribe` sites.
  if (used < budgetChars * 0.75) {
    const seen = new Set(out.map((r) => r.path).filter(Boolean));
    for (const sym of symbols) {
      if (used >= budgetChars * 0.75) break;
      const matches = await searchRepo(root, `\\b${sym}\\b`, { context: 3, maxMatches: 6 });
      const elsewhere = matches.filter((m) => m.path !== path && !seen.has(m.path));
      if (!elsewhere.length) continue;
      if (!push({ label: `Other uses of \`${sym}\``, text: renderMatches(elsewhere, 2500) })) break;
    }
  }

  return out;
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

/**
 * The files a finding names, so a claim about them can be checked.
 *
 * A verifier is given the file a finding is anchored to. That is the wrong file
 * whenever the claim is about something else — and claims about somewhere else
 * are exactly the ones that go wrong. Three times in one week: a finding
 * demanded validation that already existed in the schema module; another was
 * refused because the verifier had only an excerpt of the env module and could
 * not tell; a third asserted a prop was unsupported when the component
 * declaring it was one import away.
 *
 * So the backticked module paths and symbol names in a finding are resolved and
 * the files behind them are handed over with it. Nothing is invented: only
 * references the finding chose to write down, and only when they resolve to
 * something the repository contains.
 */
export async function filesNamedIn(
  finding: { title: string; body: string },
  root: string,
  anchoredPath: string,
  graph: GraphIndex | undefined,
  limit = 3,
): Promise<Retrieved[]> {
  const text = `${finding.title} ${finding.body}`;
  const wanted = new Map<string, string>();          // path -> why it was pulled

  // Module specifiers the finding quotes: `@/lib/env`, `src/routes/x.ts`.
  for (const m of text.matchAll(/`(@\/[\w./-]+|[\w-]+\/[\w./-]+\.[jt]sx?)`/g)) {
    const ref = m[1]!;
    if (ref.endsWith('/')) continue;                 // a directory, not a module
    const resolved = resolveImport(root, anchoredPath, ref);
    if (resolved && resolved !== anchoredPath) wanted.set(resolved, `named as \`${ref}\``);
  }

  // Symbols it names, resolved through the graph to wherever they are declared.
  //
  // A monorepo declares the same name in more than one place - a client wrapper
  // and the server service behind it both exporting the same name - and picking by
  // `exported` alone chose between them arbitrarily. It chose wrong on a real
  // false positive: the finding asked for trimming that the client wrapper the
  // anchored file imports already does, and the server copy was retrieved
  // instead, so the verifier saw code that did not settle the claim and upheld
  // it. What the anchored file imports is what the finding is talking about.
  if (graph) {
    const imported = new Set(
      (graph.importsByPath.get(anchoredPath) ?? [])
        .map((e) => resolveImport(root, anchoredPath, e.specifier))
        .filter((p): p is string => Boolean(p)),
    );
    // Failing an import edge, the nearest declaration by shared path prefix:
    // same app beats a sibling package.
    const proximity = (p: string) => {
      const a = anchoredPath.split('/');
      const b = p.split('/');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    };
    for (const m of text.matchAll(/`([A-Za-z_$][\w$]{3,})`/g)) {
      if (wanted.size >= limit) break;
      const decl = (graph.byName.get(m[1]!) ?? [])
        .filter((d) => d.path !== anchoredPath)
        .sort((a, b) =>
          Number(imported.has(b.path)) - Number(imported.has(a.path)) ||
          proximity(b.path) - proximity(a.path) ||
          Number(b.exported) - Number(a.exported))[0];
      if (decl) wanted.set(decl.path, `where \`${m[1]}\` is declared`);
    }
  }

  const out: Retrieved[] = [];
  for (const [path, why] of [...wanted].slice(0, limit)) {
    const text = await readFileHead(root, path, 160);
    if (text) out.push({ label: `\`${path}\` — ${why}`, path, text });
  }
  return out;
}
