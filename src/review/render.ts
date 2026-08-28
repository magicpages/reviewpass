import type { Finding, PullRequestContext, ReviewResult } from '../types.js';
import { WALKTHROUGH_MARKER } from '../github/client.js';

/**
 * Presentation.
 *
 * Sober on purpose. An earlier version leaned on coloured-circle emoji, badge
 * rows and nested collapsible sections — a visual language that belongs to
 * another product. The same information reads fine as plain prose and a table,
 * and a review that looks like a review rather than a dashboard is easier to
 * skim.
 */
const RISK_LABEL = {
  minimal: 'minimal', low: 'low', moderate: 'moderate', high: 'high',
} as const;

const CHECK_MARK = { passed: 'pass', warning: 'warn', failed: 'fail' } as const;

const SEVERITY_LABEL = {
  critical: 'critical', major: 'major', minor: 'minor', trivial: 'trivial',
} as const;

/** The standalone walkthrough comment, updated in place across runs. */
export function renderWalkthrough(pr: PullRequestContext, r: ReviewResult): string {
  const out: string[] = [WALKTHROUGH_MARKER, `<!-- reviewpass:sha:${pr.headSha} -->`, ''];

  const actionable = r.findings.length;
  out.push(
    actionable === 0
      ? '**Nothing to raise.**'
      : `**${actionable} finding${actionable === 1 ? '' : 's'}.**`,
    '',
    r.walkthrough,
    '',
  );

  if (r.fileGroups.length) {
    out.push('| Area | Files | Change |', '|:---|:---|:---|');
    for (const g of r.fileGroups) {
      const files = g.files.map((f) => `\`${f}\``).join('<br>');
      out.push(`| **${escapeCell(g.label)}** | ${files} | ${escapeCell(g.summary)} |`);
    }
    out.push('');
  }

  out.push(
    `Review effort ${r.effort.score}/5 (${r.effort.label.toLowerCase()}) · merge risk ${RISK_LABEL[r.mergeRisk]}`,
    '',
  );

  if (r.checks.length) {
    const failed = r.checks.filter((c) => c.status !== 'passed');
    // Only the checks that need attention. Listing four passes every time is
    // noise the reader learns to scroll past.
    if (failed.length) {
      out.push(
        `**Needs attention:** ${failed.length} of ${r.checks.length} checks`,
        '',
        ...failed.map((c) =>
          `- ${c.name} (${CHECK_MARK[c.status]}) — ${escapeCell(c.explanation).replace(/\.?$/, '.')}${
            c.resolution ? ` ${escapeCell(c.resolution).replace(/\.?$/, '.')}` : ''
          }`),
        '',
      );
    }
  }

  if (r.skipped.length) {
    out.push(`<sub>Not reviewed: ${r.skipped.map((sk) => `\`${sk.path}\``).join(', ')}</sub>`, '');
  }

  out.push(
    '<sub>`@reviewpass review` new commits · `full review` everything · '
      + '`resolve` close threads · `ignore` stop reviewing</sub>',
    '',
    `<sub>Reviewed ${pr.isIncremental ? `${short(pr.reviewedFrom)}…${short(pr.reviewedTo)}` : `up to ${short(pr.headSha)}`} · reviewpass</sub>`,
  );

  return out.join('\n');
}

/** The body attached to the review submission itself. */
export function renderReviewSummary(r: ReviewResult, unanchored: Finding[]): string {
  const out: string[] = [];

  if (r.findings.length === 0) {
    // "Nothing to raise" is a claim about the code, and it is only true if the
    // code was read. An exhausted model account failed every file on a live
    // pull request and the review said exactly that, with a green check.
    //
    // A blocked run says so in one line and stops. No verdict, no findings, no
    // ask of the author — they cannot add credits to somebody else's account,
    // and a red check for it would blame them for it.
    out.push(
      r.blocked
        ? `_${r.blocked.message} This says nothing about the change._`
        : r.failedFiles && r.failedFiles > 0
          ? `**Incomplete review.** ${r.failedFiles} of ${r.failedFiles + (r.reviewedFiles ?? 0)} file(s) failed; nothing was raised in the rest.`
          : 'Nothing to raise.',
    );
  } else {
    const bySeverity = new Map<string, number>();
    for (const f of r.findings) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    const tally = (['critical', 'major', 'minor', 'trivial'] as const)
      .filter((s) => bySeverity.has(s))
      .map((s) => `${SEVERITY_LABEL[s]} ${bySeverity.get(s)}`)
      .join(' · ');
    out.push(`**${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}** — ${tally}`);
  }

  if (unanchored.length) {
    out.push(
      '',
      `**${unanchored.length} finding${unanchored.length === 1 ? '' : 's'} outside the diff**`,
      '',
      ...unanchored.flatMap((f) => [
        `**\`${f.path}\`:${f.startLine}** — ${f.title} <sub>(${SEVERITY_LABEL[f.severity]})</sub>`,
        '',
        f.body,
        '',
      ]),
    );
  }

  return out.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

const short = (sha: string) => sha.slice(0, 7);
