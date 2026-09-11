import type { ChangedFile } from '../types.js';

/**
 * The files in both sets: changed since the last review, and part of this pull
 * request.
 *
 * The incremental side supplies the patch — it is the one describing what is
 * new — while the pull request's own file list decides what is in scope. A file
 * that appears only because the branch pulled in an update from its base
 * belongs to somebody else's change and is dropped.
 *
 * Exported rather than kept private so a test can exercise the real thing. A
 * copy of it living in the test file would pass whatever this did.
 */
export function narrowToPullRequest(
  sinceLastReview: ChangedFile[],
  inPullRequest: ChangedFile[],
): ChangedFile[] {
  const own = new Set(inPullRequest.map((f) => f.path));
  return sinceLastReview.filter((f) => own.has(f.path));
}
