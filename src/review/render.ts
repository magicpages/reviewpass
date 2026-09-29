import type { Finding, PullRequestContext, ReviewResult } from '../types.js';
import { FINDING_MARKER, WALKTHROUGH_MARKER } from '../github/client.js';

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

/**
 * How a finished review closes its check run.
 *
 * The check must never be greener than the job. A run where every file failed
 * sets the job to failed, so closing `success` there would put a green tick on
 * a pull request nothing read — the exact failure the check exists to make
 * visible, reintroduced by the thing meant to reveal it.
 *
 * Blocked closes neutral rather than red. An exhausted account, a rejected key
 * or an endpoint that is down is never the author's fault, and a red check on
 * their pull request says it is.
 */
export function renderCheckVerdict(r: ReviewResult): {
  conclusion: 'success' | 'neutral' | 'failure';
  title: string;
  summary: string;
} {
  const reviewed = r.reviewedFiles ?? 0;
  const failed = r.failedFiles ?? 0;
  const counted = `${reviewed} file(s) reviewed, ${failed} failed.`;

  if (r.blocked) {
    return { conclusion: 'neutral', title: 'Nothing was reviewed', summary: r.blocked.message };
  }
  if (reviewed === 0) {
    return failed > 0
      ? { conclusion: 'failure', title: 'No file could be reviewed', summary: counted }
      : {
          conclusion: 'neutral',
          title: 'Nothing to review',
          summary: 'Nothing in this update is a file it reviews.',
        };
  }
  const n = r.findings.length;
  const found = `${n} finding${n === 1 ? '' : 's'}`;
  return {
    conclusion: 'success',
    // Some files failed: whatever the rest held, this is not a clean review.
    title: failed > 0 ? (n === 0 ? 'Incomplete review' : `${found}, ${failed} file(s) not reviewed`)
      : n === 0 ? (listedCount(r) ? smallerPoints(listedCount(r)) : 'Nothing to raise') : found,
    summary: counted,
  };
}

const listedCount = (r: ReviewResult) => r.listed?.length ?? 0;
const smallerPoints = (n: number) => `${n} smaller point${n === 1 ? '' : 's'}`;

/** The part of a review that did not happen, e.g. "2 of 5 file(s) failed". */
function failedOf(r: ReviewResult): string {
  const failed = r.failedFiles ?? 0;
  return `${failed} of ${failed + (r.reviewedFiles ?? 0)} file(s) failed`;
}

/**
 * The walkthrough's first line, which is what a reader takes as the verdict.
 *
 * It follows the review body's rules, because it is the same claim in a more
 * visible place: "Nothing to raise" is true only when the code was read. The
 * walkthrough used to count findings alone, so a run whose only file failed
 * rewrote a pull request's summary to "Nothing to raise" while its check went
 * red - and an incremental run with nothing new erased the count of findings
 * still open from the round before.
 */
function walkthroughHeadline(r: ReviewResult): string {
  const n = r.findings.length;
  const failed = (r.failedFiles ?? 0) > 0;
  const listed = listedCount(r) ? ` ${smallerPoints(listedCount(r))} listed in the review.` : '';
  if (n > 0) return `**${n} finding${n === 1 ? '' : 's'}.**${failed ? ` ${failedOf(r)} and were not reviewed.` : ''}${listed}`;
  if (r.blocked) return `**Nothing was reviewed.** ${r.blocked.message}`;
  if (failed) return `**Incomplete review.** ${failedOf(r)}; nothing was raised in the rest.${listed}`;
  if (listedCount(r)) return `**Nothing that needs a comment.**${listed}`;
  if (r.openFindings) {
    return `**Nothing new in these commits.** ${r.openFindings} earlier finding${r.openFindings === 1 ? '' : 's'} still open.`;
  }
  return '**Nothing to raise.**';
}

/** The standalone walkthrough comment, updated in place across runs. */
export function renderWalkthrough(pr: PullRequestContext, r: ReviewResult): string {
  const out: string[] = [WALKTHROUGH_MARKER, `<!-- reviewpass:sha:${pr.headSha} -->`, ''];

  out.push(
    walkthroughHeadline(r),
    '',
    r.walkthrough,
    '',
  );

  // The summariser defaults what it returns, but it is not the only caller: a
  // failed walkthrough falls back to a hand-built object and a blocked run to
  // another. This is the last place before the comment is posted, so it checks
  // the shape it actually reads rather than trusting whoever assembled it.
  const groups = (Array.isArray(r.fileGroups) ? r.fileGroups : []).filter((g) => g && g.label);
  if (groups.length) {
    out.push('| Area | Files | Change |', '|:---|:---|:---|');
    for (const g of groups) {
      const files = (Array.isArray(g.files) ? g.files : []).map((f) => `\`${f}\``).join('<br>');
      out.push(`| **${escapeCell(String(g.label))}** | ${files} | ${escapeCell(String(g.summary ?? ''))} |`);
    }
    out.push('');
  }

  out.push(
    // Defensive on purpose. The findings are the review; a decorative line
    // about effort must not be able to throw away a run that produced them.
    `Review effort ${r.effort?.score ?? 3}/5 (${String(r.effort?.label ?? 'moderate').toLowerCase()})`
      + ` · merge risk ${RISK_LABEL[r.mergeRisk] ?? 'moderate'}`,
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
          ? `**Incomplete review.** ${failedOf(r)}; nothing was raised in the rest.`
          : listedCount(r)
            ? `Nothing that needs a comment; ${smallerPoints(listedCount(r))} below.`
            : r.openFindings
              ? `Nothing new in these commits. ${r.openFindings} earlier finding${r.openFindings === 1 ? '' : 's'} still open above.`
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
    if (r.failedFiles && r.failedFiles > 0) {
      out.push('', `_${failedOf(r)} and were not reviewed, so these findings do not cover the whole change._`);
    }

    // Verification fails open: a finding whose verify call could not run is
    // upheld rather than dropped, so a verifier outage produces a review that
    // looks exactly like a clean one while nothing has been checked. Say so.
    // The provider pool for the verify model can be down while the find model
    // is healthy, which is precisely when this is invisible from the outside.
    const unverified = r.findings.filter((f) => /^verification unavailable/.test(f.verdictReason ?? '')).length;
    if (unverified) {
      out.push(
        '',
        unverified === r.findings.length
          ? '_The verifier could not be reached. Every finding below is unverified — treat each as a question, not a conclusion._'
          : `_The verifier could not be reached for ${unverified} of ${r.findings.length} findings; those are unverified._`,
      );
    }
  }

  if (unanchored.length) {
    out.push(
      '',
      `**${unanchored.length} finding${unanchored.length === 1 ? '' : 's'} outside the diff**`,
      '',
      ...unanchored.flatMap((f) => [
        `**\`${f.path}\`:${f.startLine}** — ${f.title} <sub>(${SEVERITY_LABEL[f.severity]})</sub>${marker(f)}`,
        '',
        f.body,
        '',
      ]),
    );
  }

  // Worth knowing, not worth a thread each. Every entry carries its marker, so a
  // later round recognises it instead of raising it as new.
  const listed = r.listed ?? [];
  if (listed.length) {
    out.push(
      '',
      '<details>',
      `<summary>${smallerPoints(listed.length)}</summary>`,
      '',
      ...listed.map((f) =>
        `- **\`${f.path}\`:${f.startLine}** — ${f.title} <sub>(${SEVERITY_LABEL[f.severity]} · ${f.category})</sub>${marker(f)}`),
      '',
      '</details>',
    );
  }

  return out.join('\n');
}

const marker = (f: Finding) => (f.fingerprint ? ` ${FINDING_MARKER(f.fingerprint)}` : '');

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * The note that says a review is under way, or why one is not.
 *
 * Posted before the work starts and overwritten by the walkthrough when it
 * finishes, so it occupies one comment rather than accumulating. Other
 * reviewers do the same, and the reason is the same: a review takes ten minutes
 * or more, and without a sign of life the only thing distinguishing "thinking"
 * from "broken" is whether you happen to check the Actions tab.
 *
 * It carries the walkthrough marker deliberately. That is what lets the finished
 * review replace it in place, and what stops a second run posting a second one.
 *
 * It does NOT carry the reviewed-up-to-here marker. Only a review that finished
 * may claim a sha: a run cancelled by the next push would otherwise leave behind
 * a note saying it had reviewed a commit it never read, and the run after it
 * would start incrementally from there and approve the rest unseen. Losing a
 * genuine marker this way only costs a full re-review, which is the safe way to
 * be wrong.
 */
export function renderProgressNotice(
  pr: { headSha: string },
  state:
    | { kind: 'started'; files: number; incremental: boolean }
    | { kind: 'blocked'; message: string }
    | { kind: 'nothing'; reason: string },
): string {
  const head = `${WALKTHROUGH_MARKER}\n<!-- reviewpass:reviewing:${pr.headSha} -->\n`;
  if (state.kind === 'blocked') {
    return `${head}\n> [!WARNING]\n> ${state.message} Nothing here reflects on the change.`;
  }
  if (state.kind === 'nothing') {
    return `${head}\n> [!NOTE]\n> Not reviewing this one — ${state.reason}`;
  }
  const what = state.incremental ? 'the commits added since the last review' : 'this pull request';
  return [
    head,
    '> [!NOTE]',
    `> Reviewing ${what} — ${state.files} file${state.files === 1 ? '' : 's'}.`,
    '> Every finding is checked against the code before it is posted, so this takes',
    '> a few minutes. This note is replaced by the review when it lands.',
  ].join('\n');
}
