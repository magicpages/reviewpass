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

/**
 * What is wrong with the key, when the shape gives it away.
 *
 * A rejected key is usually the wrong *kind* of key rather than a typo, and the
 * kind is visible without looking at the value. Ollama calls both an Ed25519
 * public key and a bearer token an "API key" in its interface and only one of
 * them works over HTTP; a key for one broker pasted against another's endpoint
 * is the other common case. Both cost a person real time to find from the word
 * "unauthorized" alone.
 *
 * The key is never printed. Prefixes are matched and characters are counted;
 * the value goes nowhere, because this string is posted to a pull request.
 */
function keyShapeHint(): string {
  const key = process.env.REVIEWPASS_API_KEY ?? process.env.WARREN_API_KEY ?? '';
  if (!key) return ' No API key is set.';
  if (/^ssh-(ed25519|rsa)\b/.test(key)) {
    return ' The key looks like an SSH public key rather than a bearer token'
      + ' — some providers list both under the same heading and only one works over HTTP.';
  }
  if (key !== key.trim()) return ' The key has leading or trailing whitespace, which copying from a browser often adds.';
  if (/\s/.test(key)) return ' The key contains a space or newline, so it was probably wrapped or truncated when copied.';
  if (/^sk-or-/.test(key)) return ' The key is an OpenRouter key; check it matches the endpoint it is being sent to.';
  if (key.length < 20) return ` The key is only ${key.length} characters, shorter than any provider issues.`;
  return '';
}

export function classifyBlocker(err: unknown): Blocker | null {
  const text = err instanceof Error ? err.message : String(err);
  const status = /model (\d{3}):/.exec(text)?.[1];

  if (status === '402' || CREDITS.test(text)) {
    return { message: 'The model account is out of credits, so nothing was reviewed.' };
  }
  if (status === '401' || status === '403') {
    return { message: `The model API key was rejected, so nothing was reviewed.${keyShapeHint()}` };
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
