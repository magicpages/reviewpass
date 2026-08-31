#!/usr/bin/env node
/**
 * Rebuild the evaluation corpus from pull-request review threads.
 *
 * Nothing here needs curating. Every time a maintainer answers a review comment
 * — "fixed in abc123", or a paragraph explaining why the finding was wrong —
 * they label a case. This walks those threads and writes the labels down.
 *
 * The classifier is deliberately the same one `deriveMemory` uses at review
 * time, so what the benchmark counts as accepted is exactly what the reviewer
 * itself learns from. Two graders would drift apart within a month.
 *
 * The output is private: a finding body quotes real query shapes and describes
 * real architecture, which is why it lands in a gitignored path and why the
 * committed regression suite uses invented cases instead.
 *
 *   node scripts/harvest-triage.mjs your-org/your-repo --last 40
 *   node scripts/harvest-triage.mjs your-org/your-repo --since 2026-08-01
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ACCEPTANCE = /^\s*(fixed|done|good catch|thanks|addressed|resolved|applied|will do|agreed)\b/i;
const BOT = /reviewpass/i;

const [repo, ...rest] = process.argv.slice(2);
if (!repo || !repo.includes('/')) {
  console.error('usage: harvest-triage.mjs <owner/repo> [--last N] [--since YYYY-MM-DD] [--out PATH]');
  process.exit(2);
}
const arg = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const last = Number(arg('--last', '40'));
const since = arg('--since', null);
const out = arg('--out', 'test/cases/triaged-findings.json');

const gh = (path) => JSON.parse(execFileSync('gh', ['api', path, '--paginate'], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}));

const prs = gh(`repos/${repo}/pulls?state=all&per_page=100`)
  .filter((p) => !since || p.created_at >= since)
  .slice(0, last);

const rows = [];
let scanned = 0;
for (const pr of prs) {
  let comments;
  try { comments = gh(`repos/${repo}/pulls/${pr.number}/comments?per_page=100`); }
  catch { continue; }
  const mine = new Map(comments.filter((c) => BOT.test(c.user?.login ?? '')).map((c) => [c.id, c]));
  if (!mine.size) continue;
  scanned++;

  const replies = new Map();
  for (const c of comments) {
    const parent = c.in_reply_to_id;
    if (parent && mine.has(parent) && !BOT.test(c.user?.login ?? '')) {
      replies.set(parent, [...(replies.get(parent) ?? []), c.body]);
    }
  }

  for (const [id, c] of mine) {
    if (c.in_reply_to_id) continue;              // a reply of ours, not a finding
    const answer = (replies.get(id) ?? []).join('\n');
    if (!answer) continue;                       // untriaged: no label to record
    // A finding is posted as "**severity** · category", then a bold title, then
    // the argument. Anything after a <details> block is agent scaffolding.
    const parts = c.body.replace(/<details>[\s\S]*/, '').split('\n\n').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    rows.push({
      pr: pr.number,
      path: c.path,
      line: c.line ?? c.original_line ?? 0,
      commit: c.original_commit_id ?? '',
      severity: (parts[0].match(/\*\*(.+?)\*\*/) ?? [, 'minor'])[1],
      title: parts[1].replace(/\*\*/g, '').trim(),
      body: parts.slice(2).join(' '),
      label: ACCEPTANCE.test(answer) ? 'good' : 'bad',
      reason: answer.slice(0, 800),
    });
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(rows, null, 1));

const good = rows.filter((r) => r.label === 'good').length;
console.log(`  ${rows.length} triaged findings from ${scanned} reviewed pull request(s)`);
console.log(`  accepted ${good}  rejected ${rows.length - good}  (${Math.round((100 * good) / (rows.length || 1))}%)`);
console.log(`  written to ${out} — gitignored, contains private review text`);
