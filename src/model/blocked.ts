/**
 * Why a review could not run, said in one sentence a person can act on.
 *
 * These are not findings and not failures of the change under review — the
 * author of a pull request cannot fix an exhausted account, and a red check
 * blames them for it. They are also not nothing: an exhausted account failed
 * every file on a live pull request and the review said "Nothing to raise",
 * which is the one thing a reader takes as an all-clear.
 *
 * So they are posted as a short notice on the pull request, the way other
 * reviewers do it, and the check stays green. Whoever configured the reviewer
 * sees the reason; whoever opened the pull request sees that no review happened
 * and is not asked to do anything about it.
 */
export interface Blocker {
  /** One line, posted verbatim. No verdict, no findings. */
  message: string;
}

const CREDITS = /insufficient credits|quota|billing|payment required/i;

export function classifyBlocker(err: unknown): Blocker | null {
  const text = err instanceof Error ? err.message : String(err);
  const status = /model (\d{3}):/.exec(text)?.[1];

  if (status === '402' || CREDITS.test(text)) {
    return { message: 'The model account is out of credits, so nothing was reviewed.' };
  }
  if (status === '401' || status === '403') {
    return { message: 'The model API key was rejected, so nothing was reviewed.' };
  }
  if (status === '404') {
    return { message: 'The configured model was not found at this endpoint, so nothing was reviewed.' };
  }
  if (status === '429') {
    return { message: 'The model endpoint is rate limiting, so nothing was reviewed.' };
  }
  if (/model unreachable after retries/i.test(text)) {
    return { message: 'The model endpoint could not be reached, so nothing was reviewed.' };
  }
  return null;
}

/**
 * One blocker for the whole run, or none.
 *
 * Only when *every* file hit the same wall. A single file failing while others
 * succeed is a partial review, which is a different message and still a real
 * review of the rest.
 */
export function blockerFor(errors: unknown[], totalFiles: number): Blocker | null {
  if (!errors.length || errors.length < totalFiles) return null;
  const first = classifyBlocker(errors[0]);
  if (!first) return null;
  return errors.every((e) => classifyBlocker(e)?.message === first.message) ? first : null;
}
