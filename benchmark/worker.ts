/**
 * Run exactly one (case, method, run) and write it out. One per process.
 *
 *   npx tsx benchmark/worker.ts <cases.json> <case> <reviewpass|raw> '<ModelSetting JSON>' <run> <out.json>
 *
 * A process per run is what keeps runs independent. reviewpass holds state that
 * outlives a call - one-time warnings, the counter this harness uses to catch
 * verify failures - and two reviews sharing a process would read each other's.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runRaw, runReviewpass, type ModelSetting } from './runs.js';
import type { Case } from './types.js';

async function main() {
  const [casesPath, caseId, kind, settingJson, runArg, outPath] = process.argv.slice(2);
  if (!casesPath || !caseId || !settingJson || !runArg || !outPath || (kind !== 'reviewpass' && kind !== 'raw')) {
    throw new Error('usage: worker.ts <cases.json> <case> <reviewpass|raw> <setting-json> <run> <out.json>');
  }
  const c = (JSON.parse(readFileSync(casesPath, 'utf8')) as Case[]).find((x) => x.id === caseId);
  if (!c) throw new Error(`no case ${caseId} in ${casesPath}`);
  const setting = JSON.parse(settingJson) as ModelSetting;
  // reviewpass logs a failed verify only in debug mode, and it is the one signal
  // that a verdict never arrived (verify fails open).
  process.env.REVIEWPASS_DEBUG = '1';
  const run = kind === 'reviewpass' ? await runReviewpass(c, setting, Number(runArg)) : await runRaw(c, setting, Number(runArg));
  writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`);
  const verdict = run.error ? `ERROR ${run.error.slice(0, 80)}` : 'ok';
  console.log(`${caseId} ${run.method}#${run.run}: ${run.findings.length} findings, ${run.refuted.length} refuted, `
    + `${(run.wallMs / 1000).toFixed(0)}s, ${run.completionTokens} generated - ${verdict}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
