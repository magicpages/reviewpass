/**
 * Local driver. Runs the exact pipeline the Action runs, but prints the review
 * instead of posting it — so it can be pointed at a real PR whose outcome is
 * already known.
 *
 *   tsx src/cli.ts --repo owner/name --pr 123 --workspace /path/to/checkout
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runReview } from './pipeline.js';
import { LocalSource } from './local/source.js';
import { renderFinding } from './github/client.js';

import { importLearnings } from './store/import.js';

const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : dflt;
};
const flag = (name: string) => argv.includes(`--${name}`);

// `init-app` creates the GitHub App that gives the reviewer an identity of its
// own, so its approvals count toward branch protection. Entirely local: the
// manifest callback is a socket on this machine.
if (argv[0] === 'init-app') {
  const { initApp } = await import('./init-app.js');
  process.exit(await initApp({
    org: arg('org'),
    name: arg('name'),
    keyPath: arg('key-out'),
  }));
}

// `respond` answers replies to findings already posted. Separate from a review
// because a reply and a push need different work: one re-reads an argument, the
// other re-reads the code.
if (argv[0] === 'respond') {
  const { runRespond } = await import('./respond.js');
  const [o, rp] = (arg('repo') ?? '').split('/');
  if (!o || !rp || !Number(arg('pr'))) {
    console.error('usage: reviewpass respond --repo owner/name --pr N [--post] [--workspace DIR]');
    process.exit(1);
  }
  // Resolved here rather than through `token()`: that helper closes over
  // `base`, a const declared below this early-exit block, so calling it from
  // here would read a binding still in its temporal dead zone.
  const t = process.env.GITHUB_TOKEN
    || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const out = await runRespond({
    token: t,
    owner: o, repo: rp,
    prNumber: Number(arg('pr')),
    workspace: arg('workspace') ?? process.cwd(),
    dryRun: !flag('post'),
  });
  if (!flag('post')) console.error('\nDry run — nothing posted. Add --post to reply.');
  process.exit(out.answered ? 0 : 0);
}

// `import-knowledge` builds the retrieval store: guidelines and learnings with
// their anchors indexed. `--before-pr` exists so a benchmark can withhold
// anything the reviewer could not have known at the time.
if (argv[0] === 'import-knowledge') {
  const file = argv[1];
  const scope = arg('scope');
  if (!file || !scope) {
    console.error('usage: cli import-knowledge <file.json> --scope owner/repo [--before-pr N] --db PATH');
    process.exit(1);
  }
  const { KnowledgeStore } = await import('./store/knowledge.js');
  const { readFileSync } = await import('node:fs');
  const store = new KnowledgeStore(arg('db', '.reviewpass/knowledge.db')!);
  const beforePr = arg('before-pr') ? Number(arg('before-pr')) : undefined;
  const all = JSON.parse(readFileSync(file, 'utf8')) as {
    content: string; source_file?: string | null; source_pr?: number | null;
    learnt_from?: string | null; injections?: number | null;
  }[];

  let imported = 0;
  let withheld = 0;
  for (const l of all) {
    if (!l.content || l.content.length < 40) continue;
    if (beforePr !== undefined && l.source_pr != null && l.source_pr >= beforePr) { withheld++; continue; }
    if (store.add({
      scope,
      kind: 'learning',
      content: l.content,
      sourceFile: l.source_file ?? undefined,
      sourcePr: l.source_pr ?? undefined,
      source: l.learnt_from ? `learning from ${l.learnt_from}` : 'imported',
      weight: l.injections ?? 1,
    })) imported++;
  }
  const stats = store.stats();
  store.close();
  console.log(
    `imported ${imported} entries into ${scope}` +
    (beforePr ? ` (withheld ${withheld} from PR #${beforePr} onward)` : '') +
    `\n  ${stats.guidelines} guidelines, ${stats.learnings} learnings, ${stats.anchors} anchors`,
  );
  process.exit(0);
}

// `import-learnings` is a maintenance command, not a review.
if (argv[0] === 'import-learnings') {
  const file = argv[1];
  const scope = arg('scope');
  if (!file || !scope) {
    console.error('usage: cli import-learnings <file.json> --scope owner/repo [--before-pr N] [--db PATH]');
    process.exit(1);
  }
  // Imported here so the common path never pulls a native module into the graph.
  const { LearningStore } = await import('./store/learnings.js');
  const store = new LearningStore(arg('db', '.reviewpass/learnings.db')!);
  const beforePr = arg('before-pr') ? Number(arg('before-pr')) : undefined;
  const r = importLearnings(store, file, {
    scope,
    beforePr,
    includeUndated: argv.includes('--include-undated'),
    minInjections: arg('min-injections') ? Number(arg('min-injections')) : undefined,
  });
  const stats = store.stats();
  store.close();
  console.log(
    `imported ${r.imported} of ${r.considered} learnings into ${scope}` +
    (beforePr ? ` (only from PRs below #${beforePr})` : '') +
    `\n  skipped ${r.skippedByCutoff} by cutoff, ${r.skippedByQuality} by quality` +
    `\n  store now holds ${stats.learnings} learnings`,
  );
  process.exit(0);
}

/**
 * Two modes, one pipeline.
 *
 * `--pr N` reviews a pull request and can post to it. `--base REF` reviews a
 * local git range instead — uncommitted work included — which is what a person
 * at a terminal and an agent asked to "check what I just wrote" both want, and
 * what a pull request cannot express.
 */
const slug = arg('repo');
const base = arg('base');
const prNumber = Number(arg('pr') ?? 0);
const asJson = flag('json');

if (!base && !prNumber) {
  console.error(`usage:
  reviewpass --base main [--head REF] [--workspace DIR] [--json]
      review local changes against a base ref; nothing is posted

  reviewpass --repo owner/name --pr N [--post] [--full] [--at SHA] [--out FILE]
      review a pull request; --post submits it

  reviewpass respond --repo owner/name --pr N [--post]
      answer maintainers who replied to findings: confirm a fix, concede,
      or hold with evidence

  reviewpass init-app [--org ORG] [--name NAME] [--key-out FILE]
      create a GitHub App so reviews post under their own identity and
      approvals count toward branch protection

common: [--model NAME] [--endpoint URL] [--workspace DIR]`);
  process.exit(1);
}

const [owner, repo] = (slug ?? 'local/local').split('/') as [string, string];

function token(): string {
  // A local review never calls GitHub, so it must not demand credentials.
  if (base) return '';
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('No GITHUB_TOKEN and `gh auth token` failed.');
    process.exit(1);
  }
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const SEV_COLOR: Record<string, string> = {
  critical: '\x1b[31m', major: '\x1b[33m', minor: '\x1b[36m', trivial: '\x1b[2m',
};

const started = Date.now();

const outcome = await runReview({
  source: base ? new LocalSource(arg('workspace', process.cwd())!, base, arg('head')) : undefined,
  token: token(),
  owner,
  repo,
  prNumber,
  workspace: arg('workspace', process.cwd())!,
  fullReview: flag('full'),
  atSha: arg('at'),
  // A local review has nowhere to post; treat it as a dry run always.
  dryRun: Boolean(base) || !flag('post') || Boolean(arg('at')),
  knowledgePath: arg('knowledge'),
  rerankEndpoint: arg('rerank'),
  configOverrides: {
    name: arg('model'),
    endpoint: arg('endpoint'),
    profile: arg('profile') === 'chill' ? 'chill' : arg('profile') === 'assertive' ? 'assertive' : undefined,
  },
  log: {
    info: (m) => console.error(dim(`  ${m}`)),
    warn: (m) => console.error(`\x1b[33m  ! ${m}\x1b[0m`),
  },
});

const secs = ((Date.now() - started) / 1000).toFixed(1);

// Machine-readable output for a calling agent. Printed instead of the human
// report, not alongside it, so stdout stays parseable.
if (asJson) {
  console.log(JSON.stringify({
    range: base ? (arg('head') ? `${base}...${arg('head')}` : `${base}...working tree`) : `${slug}#${prNumber}`,
    verdict: outcome.result.event,
    candidates: outcome.candidates,
    findings: outcome.result.findings.map((f) => ({
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      severity: f.severity,
      category: f.category,
      importance: f.importance,
      title: f.title,
      body: f.body,
      suggestion: f.suggestion,
      siblings: f.siblings,
    })),
    refuted: outcome.refuted.map((f) => ({
      path: f.path, startLine: f.startLine, title: f.title, reason: f.verdictReason,
    })),
    usage: outcome.usage,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  }, null, 2));
  process.exit(0);
}

console.log(`\n${'='.repeat(74)}`);
console.log(bold(base ? `Local changes — ${outcome.pr.title}` : `${slug}#${prNumber} — ${outcome.pr.title}`));
console.log(`${'='.repeat(74)}\n`);

console.log(bold('Verdict: ') + outcome.result.event);
console.log(`Effort ${outcome.result.effort.score}/5 (${outcome.result.effort.label}) · merge risk ${outcome.result.mergeRisk}`);
console.log(`\n${outcome.result.walkthrough}\n`);

if (outcome.result.checks.length) {
  console.log(bold('Pre-merge checks'));
  for (const c of outcome.result.checks) {
    console.log(`  ${c.status === 'passed' ? '✅' : c.status === 'warning' ? '⚠️ ' : '❌'} ${c.name} — ${c.explanation}`);
  }
  console.log();
}

console.log(bold(`Findings (${outcome.result.findings.length} of ${outcome.candidates} candidates)`));
for (const f of outcome.result.findings) {
  const c = SEV_COLOR[f.severity] ?? '';
  console.log(`\n  ${c}${f.severity.toUpperCase()}\x1b[0m ${f.category}  ${f.path}:${f.startLine}-${f.endLine}`);
  console.log(`  ${bold(f.title)}`);
  console.log(`  ${f.body.replace(/\n/g, '\n  ')}`);
  if (f.suggestion) console.log(dim(`  [has committable suggestion]`));
  if (f.siblings?.length) console.log(dim(`  [also affects ${f.siblings.map((s) => s.path).join(', ')}]`));
  if (f.confidence !== undefined) console.log(dim(`  [verifier: ${f.verdictReason} (${f.confidence})]`));
}

if (outcome.refuted.length) {
  console.log(`\n${bold(`Refuted by verification (${outcome.refuted.length})`)}`);
  for (const f of outcome.refuted) {
    console.log(dim(`  ✗ ${f.path}:${f.startLine} ${f.title}`));
    console.log(dim(`      ${f.verdictReason}`));
  }
}

if (outcome.plan.unanchored.length) {
  console.log(`\n${bold(`Could not anchor inline (${outcome.plan.unanchored.length})`)}`);
  for (const f of outcome.plan.unanchored) console.log(dim(`  ${f.path}:${f.startLine} ${f.title}`));
}

console.log(
  `\n${dim(`${secs}s · ${outcome.usage.promptTokens.toLocaleString()} prompt / ` +
    `${outcome.usage.completionTokens.toLocaleString()} completion tokens · ` +
    `${flag('post') ? 'POSTED' : 'dry run, nothing posted'}`)}\n`,
);

const out = arg('out');
if (out) {
  writeFileSync(out, JSON.stringify({
    repo: slug, pr: prNumber, title: outcome.pr.title,
    event: outcome.result.event,
    effort: outcome.result.effort,
    mergeRisk: outcome.result.mergeRisk,
    walkthrough: outcome.result.walkthrough,
    checks: outcome.result.checks,
    findings: outcome.result.findings,
    refuted: outcome.refuted,
    candidates: outcome.candidates,
    usage: outcome.usage,
    seconds: Number(secs),
    renderedComments: outcome.plan.anchored.map((a) => ({ path: a.path, line: a.line, body: a.body })),
  }, null, 2));
  console.error(dim(`  wrote ${out}`));
}

// Keep the renderer referenced so the comment shape stays type-checked here too.
void renderFinding;
