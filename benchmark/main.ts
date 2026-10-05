/**
 * The benchmark, end to end: runs, then the reference, then the report.
 *
 *   npx tsx benchmark/main.ts <run-config.json> [runs|reference|report|filters|calibrate|all]
 *
 * Every stage writes its result and skips work already done, so an interrupted
 * benchmark resumes rather than paying for the same calls twice. Endpoints,
 * models and prices come from the run config; keys come from the environment,
 * named in the config and never written into it. Keep the config under eval/.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnRun } from './child.js';
import { collidingKeys, methodKey, runFileStem, type ModelSetting } from './runs.js';
import { groupCauses, judgeCauses, assignFindings, extendReference, placeIntoReference, unplacedFindings, type Judges } from './reference.js';
import { compareRulings, comparePlacements, withRulings, meanScores } from './calibrate.js';
import { Spend, type Judge } from './judges.js';
import { scoreCase, consistency, scoreFilters, STANDARD_FILTERS, type MethodScore } from './score.js';
import type { BenchFinding, Case, Cause, ReferenceEntry, Run } from './types.js';

interface JudgeConfig extends Omit<Judge, 'key'> { keyEnv: string }
interface RunConfig {
  cases: string;
  out: string;
  runs: number;
  /** Runs in flight at once, each its own process. */
  parallel: number;
  /** Variable holding the key the reviewed methods use. */
  keyEnv: string;
  /** Environment for the reviewed runs, e.g. REVIEWPASS_CONCURRENCY for an endpoint that rate-limits. */
  env?: Record<string, string>;
  methods: Method[];
  judges: { first: JudgeConfig; second: JudgeConfig; tiebreak: JudgeConfig };
  spendCap: number;
  /**
   * Another panel, measured against the one the reference was built with by the
   * `calibrate` stage before it is trusted to extend the reference.
   */
  calibrate?: { judges: { first: JudgeConfig; second: JudgeConfig; tiebreak: JudgeConfig } };
}

interface Method {
  kind: 'reviewpass' | 'raw';
  model: ModelSetting;
  /** The case ids this method runs on; every case when omitted. */
  cases?: string[];
}
const runsOn = (m: Method, caseId: string) => !m.cases || m.cases.includes(caseId);

const safe = runFileStem;
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
const writeJson = (p: string, v: unknown) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

function key(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// ------------------------------------------------------------------ runs

function worker(cfg: RunConfig, c: Case, kind: string, model: ModelSetting, run: number, out: string): Promise<void> {
  return spawnRun('npx', ['tsx', 'benchmark/worker.ts', cfg.cases, c.id, kind, JSON.stringify(model), String(run), out],
    { ...process.env, ...cfg.env, REVIEWPASS_API_KEY: key(cfg.keyEnv) }, out,
    (why) => ({ caseId: c.id, method: methodKey(kind === 'raw' ? 'raw' : 'reviewpass', model), run,
      findings: [], refuted: [], wallMs: 0, promptTokens: 0, completionTokens: 0, error: why }));
}

async function runs(cfg: RunConfig, cases: Case[]) {
  const dir = join(cfg.out, 'runs');
  mkdirSync(dir, { recursive: true });
  const jobs: (() => Promise<void>)[] = [];
  for (const c of cases) for (const m of cfg.methods.filter((x) => runsOn(x, c.id))) for (let r = 1; r <= cfg.runs; r++) {
    const out = join(dir, `${c.id}__${safe(methodKey(m.kind, m.model))}__${r}.json`);
    // A run that failed is retried; one that completed is not paid for twice.
    if (existsSync(out) && !readJson<Run>(out).error) continue;
    jobs.push(() => worker(cfg, c, m.kind, m.model, r, out));
  }
  console.log(`runs: ${jobs.length} to do, ${cfg.parallel} at a time`);
  let next = 0;
  await Promise.all(Array.from({ length: cfg.parallel }, async () => { while (next < jobs.length) await jobs[next++]!(); }));
}

function loadRuns(cfg: RunConfig, caseId: string): Run[] {
  const dir = join(cfg.out, 'runs');
  const out: Run[] = [];
  for (const m of cfg.methods.filter((x) => runsOn(x, caseId))) for (let r = 1; r <= cfg.runs; r++) {
    const p = join(dir, `${caseId}__${safe(methodKey(m.kind, m.model))}__${r}.json`);
    if (!existsSync(p)) throw new Error(`missing run ${p}: run the "runs" stage first`);
    out.push(readJson<Run>(p));
  }
  return out;
}

// ------------------------------------------------------------------ reference

const judge = (j: JudgeConfig): Judge => ({ ...j, key: key(j.keyEnv) });

interface CaseReference {
  entries: ReferenceEntry[];
  placed: [string, string | null][];
  disputed: number;
  spent: number;
  /** How many times new runs were placed into it after it was built. */
  extensions?: number;
}

async function reference(cfg: RunConfig, cases: Case[]) {
  const dir = join(cfg.out, 'reference');
  mkdirSync(dir, { recursive: true });
  const j: Judges = { first: judge(cfg.judges.first), second: judge(cfg.judges.second), tiebreak: judge(cfg.judges.tiebreak) };
  const spend = new Spend(cfg.spendCap);
  process.env.BENCH_UNUSABLE_DIR = join(cfg.out, 'unusable');
  process.env.BENCH_JUDGE_CACHE = join(cfg.out, 'judge-cache');
  for (const c of cases) {
    const out = join(dir, `${c.id}.json`);
    const rs = loadRuns(cfg, c.id);
    // A degraded run's findings are not what the method produces, and a reference
    // built from them goes stale the moment the run is redone.
    const failed = rs.filter((r) => r.error);
    if (failed.length) {
      throw new Error(`${c.id}: ${failed.length} run(s) failed or degraded - rerun the "runs" stage before judging:\n`
        + failed.map((r) => `  ${r.method}#${r.run}: ${r.error}`).join('\n'));
    }
    // The pool is everything anything raised, plus what the history already settled.
    const history: BenchFinding[] = c.history.map((h, i) => ({
      id: `${c.id}/history/${i}`, path: h.path, startLine: h.line, endLine: h.line, title: h.title, body: h.body,
    }));
    const pool = [...rs.flatMap((r) => [...r.findings, ...r.refuted]), ...history];
    const before = spend.spent;
    if (existsSync(out)) {
      // Built already. Runs added since then are placed into it rather than
      // judging the whole case again.
      const ref = readJson<CaseReference>(out);
      const fresh = unplacedFindings(pool, ref.placed);
      if (!fresh.length) continue;
      const n = (ref.extensions ?? 0) + 1;
      const ext = await extendReference(c, fresh, ref.entries, j, spend, `x${n}`);
      writeJson(out, {
        entries: [...ref.entries, ...ext.entries], placed: [...ref.placed, ...ext.placed],
        disputed: ref.disputed + ext.disputed, spent: ref.spent + spend.spent - before, extensions: n,
      } satisfies CaseReference);
      console.log(`reference ${c.id}: placed ${fresh.length} new findings, ${ext.entries.length} new causes `
        + `(${ext.entries.filter((e) => e.defect).length} defects), spent ${(spend.spent - before).toFixed(2)}`);
      continue;
    }
    // Each stage is kept as it completes: a later stage failing must not make the
    // earlier, paid-for ones run again.
    const stage = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const p = join(dir, `${c.id}.${name}.json`);
      if (existsSync(p)) return readJson<T>(p);
      const v = await run();
      writeJson(p, v);
      return v;
    };
    const causes = await stage('causes', () => groupCauses(c, pool, j.first, spend));
    const entries = await stage('entries', () => judgeCauses(c, causes, new Map(pool.map((f) => [f.id, f])), j, spend));
    const { final, disputed } = await assignFindings(c, pool, entries, j, spend);
    writeJson(out, { entries, placed: [...final], disputed, spent: spend.spent - before } satisfies CaseReference);
    console.log(`reference ${c.id}: ${pool.length} findings -> ${entries.length} causes, `
      + `${entries.filter((e) => e.defect).length} defects, ${entries.filter((e) => e.settledBy === 'tiebreak').length} by tiebreak, `
      + `${disputed} placements disputed, spent ${(spend.spent - before).toFixed(2)}`);
  }
}

// ------------------------------------------------------------------ report

function report(cfg: RunConfig, cases: Case[]) {
  const scores: MethodScore[] = [];
  const lines: string[] = ['# Benchmark', ''];
  const allRuns: Run[] = [];
  const allRef: ReferenceEntry[] = [];
  const allPlaced = new Map<string, string | null>();
  const agreement: string[] = [];
  for (const c of cases) {
    const ref = readJson<CaseReference>(join(cfg.out, 'reference', `${c.id}.json`));
    const tied = ref.entries.filter((e) => e.settledBy === 'tiebreak').length;
    agreement.push(`| ${c.id} | ${tied} of ${ref.entries.length} | ${ref.disputed} of ${ref.placed.length} | ${ref.spent.toFixed(2)} |`);
    const rs = loadRuns(cfg, c.id);
    const placed = new Map(ref.placed);
    scores.push(...scoreCase(ref.entries, placed, rs));
    allRuns.push(...rs); allRef.push(...ref.entries);
    for (const [k, v] of placed) allPlaced.set(k, v);
  }
  const methods = cfg.methods.map((m) => methodKey(m.kind, m.model));
  const cell = (caseId: string, method: string, pick: (s: MethodScore) => string) => {
    const s = scores.find((x) => x.caseId === caseId && x.method === method);
    return s ? pick(s) : '-';
  };
  const table = (title: string, pick: (s: MethodScore) => string) => {
    lines.push(`## ${title}`, '', `| method | ${cases.map((c) => `${c.id} (${allRef.filter((e) => e.caseId === c.id && e.defect).length})`).join(' | ')} |`,
      `|---|${cases.map(() => '---').join('|')}|`);
    for (const m of methods) lines.push(`| ${m} | ${cases.map((c) => cell(c.id, m, pick)).join(' | ')} |`);
    lines.push('');
  };
  const perRun = (f: (r: MethodScore['runs'][number]) => string) => (s: MethodScore) => s.runs.map(f).join(', ');

  table('Hits per run', perRun((r) => (r.error && !r.findings ? 'fail' : String(r.hits))));
  table('False findings per run', perRun((r) => String(r.falseFindings)));
  table('Union of all runs', (s) => String(s.unionHits));
  table('Files the model failed on, per run', perRun((r) => String(r.failedFiles)));
  table('Minutes per run', perRun((r) => (r.wallMs / 60000).toFixed(1)));
  table('Generated tokens per run (thousands)', perRun((r) => (r.completionTokens / 1000).toFixed(0)));

  lines.push('## Found in how many runs, by severity', '', `| method | severity | ${Array.from({ length: cfg.runs + 1 }, (_, k) => `${k} of ${cfg.runs}`).join(' | ')} |`,
    `|---|---|${Array.from({ length: cfg.runs + 1 }, () => '---').join('|')}|`);
  for (const m of methods) {
    const con = consistency(allRef, allPlaced, allRuns, m);
    for (const [sev, counts] of Object.entries(con)) if (counts.some((n) => n)) lines.push(`| ${m} | ${sev} | ${counts.join(' | ')} |`);
  }
  lines.push('', '## What the verifier removed', '', '| method | real defects removed | noise removed | unplaced |', '|---|---|---|---|');
  for (const m of methods.filter((x) => x.startsWith('reviewpass'))) {
    const v = scores.filter((s) => s.method === m).reduce((a, s) => ({
      refutedReal: a.refutedReal + s.verifier.refutedReal, refutedNoise: a.refutedNoise + s.verifier.refutedNoise,
      refutedUnplaced: a.refutedUnplaced + s.verifier.refutedUnplaced }), { refutedReal: 0, refutedNoise: 0, refutedUnplaced: 0 });
    lines.push(`| ${m} | ${v.refutedReal} | ${v.refutedNoise} | ${v.refutedUnplaced} |`);
  }
  const failures = allRuns.filter((r) => r.error);
  if (failures.length) {
    lines.push('', '## Failed or degraded runs', '');
    for (const r of failures) lines.push(`- ${r.caseId} ${r.method} #${r.run}: ${r.error}`);
  }
  // How far the judges agreed: a reference the tiebreak had to settle often is a shaky one.
  lines.push('', '## Judges', '', `${cfg.judges.first.name} and ${cfg.judges.second.name}, `
    + `with ${cfg.judges.tiebreak.name} settling their disagreements.`, '',
    '| case | causes settled by tiebreak | placements disputed | spent |', '|---|---|---|---|', ...agreement);
  const partial = cfg.methods.filter((m) => m.cases);
  if (partial.length) {
    lines.push('', '## Methods run on a subset', '');
    for (const m of partial) lines.push(`- ${methodKey(m.kind, m.model)}: ${m.cases!.join(', ')} only (\`-\` in the tables above)`);
  }
  lines.push('', `Reference: ${allRef.filter((e) => e.defect).length} defects and ${allRef.filter((e) => !e.defect).length} non-defects `
    + `across ${cases.length} pull requests - a lower bound, since a defect no run and no reviewer raised is not in it.`);
  writeFileSync(join(cfg.out, 'report.md'), `${lines.join('\n')}\n`);
  writeJson(join(cfg.out, 'scores.json'), scores);
  console.log(`report: ${join(cfg.out, 'report.md')}`);
}

// ------------------------------------------------------------------ filters

/**
 * What each filter would have done to the methods that record `meta`: real
 * defects it costs against noise it removes. Reads the runs and the reference
 * only, so it is free to run as often as the question changes.
 */
function filters(cfg: RunConfig, cases: Case[]) {
  const ref: ReferenceEntry[] = [];
  const placed = new Map<string, string | null>();
  const runs: Run[] = [];
  for (const c of cases) {
    const r = readJson<CaseReference>(join(cfg.out, 'reference', `${c.id}.json`));
    ref.push(...r.entries);
    for (const [k, v] of r.placed) placed.set(k, v);
    runs.push(...loadRuns(cfg, c.id));
  }
  const scores = scoreFilters(ref, placed, runs, STANDARD_FILTERS);
  const lines = ['# Filters', '', `Summed over ${cases.length} cases and every run of each method. A filter keeps a finding`
    + ' or drops it before posting; hits are distinct reference defects a run still finds.', ''];
  for (const method of new Set(scores.map((x) => x.method))) {
    const mine = scores.filter((x) => x.method === method);
    const base = mine.find((x) => x.filter === STANDARD_FILTERS[0]!.name)!;
    lines.push(`## ${method}`, '', '| filter | hits | false findings | real defects lost | noise removed | posted |',
      '|---|---|---|---|---|---|');
    for (const x of mine) {
      lines.push(`| ${x.filter} | ${x.hits} | ${x.falseFindings} | ${base.hits - x.hits} | ${base.falseFindings - x.falseFindings} | ${x.findings} |`);
    }
    lines.push('');
  }
  if (!scores.length) lines.push('No method records `meta` yet; nothing to score.');
  writeFileSync(join(cfg.out, 'filters.md'), `${lines.join('\n')}\n`);
  console.log(`filters: ${join(cfg.out, 'filters.md')}`);
}

// ------------------------------------------------------------------ calibrate

/** Every run of a case on disk, whatever config produced it. */
function allRuns(cfg: RunConfig, caseId: string): Run[] {
  const dir = join(cfg.out, 'runs');
  return readdirSync(dir).filter((f) => f.startsWith(`${caseId}__`) && f.endsWith('.json'))
    .map((f) => readJson<Run>(join(dir, f)));
}

/**
 * Re-rule every cause of the reference with the `calibrate` panel, re-place the
 * findings of this config's methods, and report how far the two panels agree and
 * whether the difference would change any method's score.
 */
async function calibrate(cfg: RunConfig, cases: Case[]) {
  if (!cfg.calibrate) throw new Error('the config has no "calibrate" panel');
  const dir = join(cfg.out, 'calibration');
  mkdirSync(dir, { recursive: true });
  const p = cfg.calibrate.judges;
  const j: Judges = { first: judge(p.first), second: judge(p.second), tiebreak: judge(p.tiebreak) };
  const spend = new Spend(cfg.spendCap);
  process.env.BENCH_UNUSABLE_DIR = join(cfg.out, 'unusable');
  process.env.BENCH_JUDGE_CACHE = join(cfg.out, 'judge-cache');
  const kept = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const file = join(dir, name);
    if (existsSync(file)) return readJson<T>(file);
    const v = await run();
    writeJson(file, v);
    return v;
  };
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  const lines = ['# Calibration', '', `Reference panel: ${cfg.judges.first.name} and ${cfg.judges.second.name}, `
    + `${cfg.judges.tiebreak.name} settling. Panel measured: ${p.first.name} and ${p.second.name}, ${p.tiebreak.name} settling.`, '',
    '## Rulings', '', '| case | causes | agree | defect by reference only | defect by panel only | same severity |', '|---|---|---|---|---|---|'];
  const scoreLines: string[] = [];
  const placeLines: string[] = [];
  for (const c of cases) {
    const refFile = join(cfg.out, 'reference', `${c.id}.json`);
    if (!existsSync(refFile)) throw new Error(`${c.id}: no reference to calibrate against - run the "reference" stage first`);
    const ref = readJson<CaseReference>(refFile);
    const placed = new Map(ref.placed);
    const every = allRuns(cfg, c.id);
    const history: BenchFinding[] = c.history.map((h, i) => ({
      id: `${c.id}/history/${i}`, path: h.path, startLine: h.line, endLine: h.line, title: h.title, body: h.body,
    }));
    const texts = new Map([...every.flatMap((r) => [...r.findings, ...r.refuted]), ...history].map((f) => [f.id, f]));
    const causes: Cause[] = ref.entries.map(({ id, caseId, path, members, mechanism }) => ({ id, caseId, path, members, mechanism }));
    const ruled = await kept(`${c.id}.entries.json`, () => judgeCauses(c, causes, texts, j, spend));
    const a = compareRulings(ref.entries, ruled);
    lines.push(`| ${c.id} | ${a.causes} | ${pct(a.bothDefect + a.bothNot, a.causes)} | ${a.referenceOnly} | ${a.panelOnly} | `
      + `${a.sameSeverity} of ${a.bothDefect} |`);

    // Placement is what extending a reference mostly asks of a panel. Only the
    // runs on disk: a method not run on this case has nothing to place. The
    // cache is keyed by the findings placed, so changing the methods places again.
    const keys = new Set(cfg.methods.filter((m) => runsOn(m, c.id)).map((m) => methodKey(m.kind, m.model)));
    const mine = every.filter((r) => keys.has(r.method)).flatMap((r) => [...r.findings, ...r.refuted]).filter((f) => placed.has(f.id));
    const placedKey = createHash('sha256').update(mine.map((f) => f.id).sort().join('\n')).digest('hex').slice(0, 12);
    const replaced = new Map(await kept(`${c.id}.placed.${placedKey}.json`,
      async () => [...(await placeIntoReference(c, mine, ref.entries, j, spend)).final]));
    const pl = comparePlacements(placed, replaced);
    placeLines.push(`| ${c.id} | ${pl.findings} | ${pct(pl.same, pl.findings)} | ${pl.moved} | ${pl.unplacedByOne} |`);

    // Only runs the reference has placed in full: the scores compare panels, not coverage.
    const judged = every.filter((r) => !r.error && [...r.findings, ...r.refuted].every((f) => placed.has(f.id)));
    const before = meanScores(ref.entries, placed, judged);
    const after = meanScores(withRulings(ref.entries, ruled), placed, judged);
    for (const [method, b] of before) {
      const x = after.get(method)!;
      scoreLines.push(`| ${c.id} | ${method} | ${b.hits.toFixed(1)} | ${x.hits.toFixed(1)} | ${b.falseFindings.toFixed(1)} | ${x.falseFindings.toFixed(1)} |`);
    }
  }
  lines.push('', '## Placements', '', 'Findings of this config\'s methods, placed again under the reference\'s causes.', '',
    '| case | findings | same cause | moved | placed by one panel only |', '|---|---|---|---|---|', ...placeLines,
    '', '## Scores', '', 'Mean per run, same causes and placements, each panel\'s rulings.', '',
    '| case | method | hits (reference) | hits (panel) | false (reference) | false (panel) |', '|---|---|---|---|---|---|', ...scoreLines,
    '', `Spent ${spend.spent.toFixed(2)}, ${(spend.tokens / 1e6).toFixed(1)}M tokens.`);
  writeFileSync(join(cfg.out, 'calibration.md'), `${lines.join('\n')}\n`);
  console.log(`calibration: ${join(cfg.out, 'calibration.md')}`);
}

async function main() {
  const [configPath, stage = 'all'] = process.argv.slice(2);
  if (!configPath) throw new Error('usage: main.ts <run-config.json> [runs|reference|report|filters|calibrate|all]');
  const cfg = readJson<RunConfig>(configPath);
  const clash = collidingKeys(cfg.methods.map((m) => methodKey(m.kind, m.model)));
  if (clash.length) {
    throw new Error(`these methods would share run files; give them labels that differ in letters or digits: `
      + clash.map((c) => c.join(' / ')).join('; '));
  }
  const cases = readJson<Case[]>(cfg.cases);
  if (stage === 'runs' || stage === 'all') await runs(cfg, cases);
  if (stage === 'reference' || stage === 'all') await reference(cfg, cases);
  if (stage === 'report' || stage === 'all') report(cfg, cases);
  if (stage === 'filters' || stage === 'all') filters(cfg, cases);
  if (stage === 'calibrate') await calibrate(cfg, cases);
}

main().catch((e) => { console.error(e); process.exit(1); });
