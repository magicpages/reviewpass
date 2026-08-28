import { envAny, type ReviewpassConfig } from '../config/index.js';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

interface ChatChoice {
  message: { content: string | null; reasoning_content?: string | null };
  finish_reason: string;
}
interface ChatResponse {
  choices: ChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface CallOptions {
  schema?: object;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface CallResult<T> {
  value: T;
  reasoning: string;
  promptTokens: number;
  completionTokens: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ~4 chars per token is close enough for budgeting, and needs no tokenizer. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export class ModelClient {
  private totalPrompt = 0;
  private totalCompletion = 0;
  /** Round-robin cursor over the replica list. */
  private next = 0;

  constructor(private cfg: ReviewpassConfig) {}

  /**
   * The endpoints to spread work over. Replicas are independent servers holding
   * the same model, so any of them can serve any request.
   */
  private get replicas(): string[] {
    const list = this.cfg.model.endpoints?.length ? this.cfg.model.endpoints : [this.cfg.model.endpoint];
    return list;
  }

  private pickEndpoint(): string {
    const list = this.replicas;
    const url = list[this.next % list.length]!;
    this.next++;
    return url;
  }

  get usage() {
    return { promptTokens: this.totalPrompt, completionTokens: this.totalCompletion };
  }

  /** Free-text completion. */
  async text(messages: ChatMessage[], opts: CallOptions = {}): Promise<CallResult<string>> {
    const r = await this.raw(messages, opts);
    return { ...r, value: r.value };
  }

  /**
   * Schema-constrained completion. llama.cpp enforces the grammar, so the only
   * realistic failure is an empty body when the thinking budget swallowed the
   * whole generation — which is why maxTokens is generous and we retry once.
   */
  async json<T>(messages: ChatMessage[], schema: object, opts: CallOptions = {}): Promise<CallResult<T>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.raw(messages, {
        ...opts,
        schema,
        // A thinking model spends tokens before it emits a byte of JSON.
        maxTokens: (opts.maxTokens ?? this.cfg.model.maxTokens) * (attempt + 1),
      });
      const body = r.value.trim();
      if (!body) { lastErr = new Error('model returned no content (thinking consumed the budget)'); continue; }
      try {
        return { ...r, value: JSON.parse(body) as T };
      } catch (err) {
        lastErr = err;
        // Grammar-constrained output can still be truncated: salvage the object.
        const salvaged = salvageJson(body);
        if (salvaged) return { ...r, value: salvaged as T };
      }
    }
    throw new Error(`model did not return usable JSON: ${String(lastErr).slice(0, 300)}`);
  }

  private async raw(messages: ChatMessage[], opts: CallOptions): Promise<CallResult<string>> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.cfg.model.name,
      messages,
      temperature: opts.temperature ?? this.cfg.model.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.model.maxTokens,
    };
    if (opts.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: opts.schemaName ?? 'result', strict: true, schema: opts.schema },
      };
    }
    // Routing is the operator's to decide, not ours. Whatever is configured is
    // passed through untouched; `REVIEWPASS_ZDR=1` stays as a shorthand for the
    // common case of "zero-retention providers only", so CI can set it without
    // a config file. Unset, nothing is sent and a plain OpenAI-compatible
    // server sees a request it understands.
    //
    // Worth configuring deliberately on a broker: reviewing ships proprietary
    // source to whoever serves the request, and a broker left to route on price
    // can land on a provider serving the same model an order of magnitude
    // slower than the fast end of its pool.
    const provider = this.cfg.model.provider
      ?? (envAny('ZDR') === '1' ? { zdr: true } : undefined);
    if (provider && Object.keys(provider).length) body.provider = provider;

    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.cfg.model.requestTimeoutMs);
      // A retry moves to the next replica: if one is wedged, the other answers.
      const endpoint = this.pickEndpoint();
      try {
        const res = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(envAny('API_KEY') ? { Authorization: `Bearer ${envAny('API_KEY')}` } : {}),
          },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          // A model swap on a 2-slot router shows up as a 503 for a few seconds.
          if (res.status === 503 || res.status >= 500) throw new Error(`upstream ${res.status}: ${text.slice(0, 200)}`);
          throw Object.assign(new Error(`model ${res.status}: ${text.slice(0, 300)}`), { fatal: true });
        }
        const json = (await res.json()) as ChatResponse;
        const choice = json.choices[0];
        if (!choice) throw new Error('model returned no choices');
        this.totalPrompt += json.usage?.prompt_tokens ?? 0;
        this.totalCompletion += json.usage?.completion_tokens ?? 0;
        return {
          value: choice.message.content ?? '',
          reasoning: choice.message.reasoning_content ?? '',
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        };
      } catch (err) {
        lastErr = err;
        if ((err as { fatal?: boolean }).fatal) throw err;
        await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`model unreachable after retries: ${String(lastErr).slice(0, 300)}`);
  }
}

/** Recover the largest balanced JSON object from a truncated response. */
function salvageJson(s: string): unknown {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
