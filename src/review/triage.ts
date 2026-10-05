/**
 * Which verified findings are posted inline, which are listed in the review
 * body, and which are not posted at all.
 *
 * A review is read, not only checked. Sixty-nine findings on one pull request,
 * twenty-five of them inline, each opening a thread, is a review nobody reads to
 * the end - and a round of fixes that draws eighteen more trains the author to
 * stop reading. So a first review posts its most important findings inline and
 * lists the rest; a follow-up round raises only what matters; and the kinds of
 * finding that were measured to be mostly noise - trivial ones, maintainability
 * findings the verifier rated low, and requests for more tests - are listed or
 * dropped.
 */
import type { ReviewpassConfig } from '../config/index.js';
import type { Finding } from '../types.js';
import { isCoverageRequest } from './run.js';

export interface Triaged {
  /** Posted as inline comments, in ranked order. */
  inline: Finding[];
  /** Listed in the review body: visible, but not a thread each. */
  listed: Finding[];
  /** Not posted. */
  dropped: Finding[];
}

const SEVERITY_RANK: Record<Finding['severity'], number> = { trivial: 0, minor: 1, major: 2, critical: 3 };

/**
 * `ranked` must already be in priority order (see `rankAndCap`): the caps keep
 * the first findings inline. A finding the verifier could not rate has no
 * importance, and is never listed or dropped for that - an outage must not hide
 * findings.
 */
export function triageFindings(ranked: Finding[], review: ReviewpassConfig['review'], followUp: boolean): Triaged {
  const out: Triaged = { inline: [], listed: [], dropped: [] };
  const cap = followUp ? review.followUpMaxInline : review.maxInline;
  for (const f of ranked) {
    const critical = f.severity === 'critical';
    const importance = f.importance;
    if (review.dropTrivial && f.severity === 'trivial') { out.dropped.push(f); continue; }
    if (f.category === 'maintainability' && importance !== undefined && !critical) {
      if (importance < review.maintainabilityListAt) { out.dropped.push(f); continue; }
      if (importance < review.maintainabilityInlineAt) { out.listed.push(f); continue; }
    }
    if (review.listCoverageRequests && !critical && isCoverageRequest(f)) { out.listed.push(f); continue; }
    if (followUp && !critical) {
      const severe = SEVERITY_RANK[f.severity] >= SEVERITY_RANK[review.followUpMinSeverity];
      const important = importance !== undefined && importance >= review.followUpMinImportance;
      if (!severe && !important) { out.listed.push(f); continue; }
    }
    // Past the cap a finding is listed, never dropped - except a critical one,
    // which is always inline.
    if (out.inline.length >= cap && !critical) { out.listed.push(f); continue; }
    out.inline.push(f);
  }
  return out;
}
