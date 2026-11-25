/**
 * The model that takes over when the Claude subscription is spent.
 *
 * With every Claude token at its usage limit, a review used to refuse every file
 * until the first token reset, which on a weekly limit is days. A fallback sends
 * those calls to an OpenAI-compatible endpoint instead, for as long as no token
 * is free; the next call that finds one goes back to Claude.
 *
 * Read from the environment only, never from `.reviewpass.yaml`: comment-
 * triggered runs check out the pull request head, and a file there could point
 * the fallback's key at an endpoint of its own choosing.
 */
import { envAny, validEffort, type ReviewpassConfig } from '../config/index.js';

export interface Fallback {
  /** The review's configuration with the model swapped for the fallback's. */
  config: ReviewpassConfig;
  /** Sent as the bearer token; unset for a server that needs none. */
  key?: string;
}

/**
 * The fallback the environment configures, or null when it configures none.
 *
 * `REVIEWPASS_FALLBACK_ENDPOINT` and `REVIEWPASS_FALLBACK_MODEL` turn it on;
 * `REVIEWPASS_FALLBACK_API_KEY`, `REVIEWPASS_FALLBACK_REASONING_EFFORT` and
 * `REVIEWPASS_FALLBACK_PROVIDER` (OpenRouter's routing field, as JSON) are
 * optional. The fallback model both finds and verifies: the configured verify
 * model is a Claude one, and the subscription is what is spent.
 */
export function fallbackFromEnv(cfg: ReviewpassConfig): Fallback | null {
  const endpoint = envAny('FALLBACK_ENDPOINT')?.trim();
  const name = envAny('FALLBACK_MODEL')?.trim();
  if (!endpoint || !name) return null;
  const effort = envAny('FALLBACK_REASONING_EFFORT')?.trim();
  const provider = envAny('FALLBACK_PROVIDER')?.trim();
  const config = structuredClone(cfg);
  config.model = {
    ...config.model,
    backend: 'openai',
    endpoint,
    endpoints: [endpoint],
    name,
    verifyModel: name,
    reasoningEffort: effort ? validEffort(effort) : undefined,
    verifyReasoningEffort: undefined,
    provider: provider ? parseProvider(provider) : undefined,
  };
  return { config, key: envAny('FALLBACK_API_KEY')?.trim() || undefined };
}

/**
 * The routing object, or a loud failure. A typo here would otherwise drop the
 * routing silently, and the routing is where an operator keeps the code in the
 * region or away from providers that retain it.
 */
function parseProvider(raw: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('REVIEWPASS_FALLBACK_PROVIDER is not valid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('REVIEWPASS_FALLBACK_PROVIDER must be a JSON object, for example {"only":["inceptron"]}');
  }
  return v as Record<string, unknown>;
}
