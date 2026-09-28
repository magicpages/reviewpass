/**
 * LLM judges for the reference.
 *
 * A judge must never supply a verdict it did not reach. reviewpass's verifier
 * fails open by design - a lost verdict keeps the finding - and a benchmark
 * built on the same habit would score every judge failure as an agreement. So a
 * reply that cannot be parsed and validated is retried and then thrown: the
 * stage stops, and nothing is recorded in its place.
 *
 * Judges are chosen from outside every candidate's model family, so no model
 * under test grades its own lineage.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withSchema, salvageJson, type ChatMessage } from '../src/model/client.js';

export interface Judge {
  name: string;
  endpoint: string;
  model: string;
  key: string;
  /** Sent verbatim, e.g. OpenRouter's `provider` routing. */
  extra?: Record<string, unknown>;
  /**
   * First attempt's output budget, doubled on each retry. Default 16,384; a model
   * that reasons past that on every call should start higher, or its first
   * attempt is paid for and thrown away each time.
   */
  maxTokens?: number;
  /** Per million tokens, in the account's currency - used to hold the spend cap. */
  price: { input: number; output: number };
}

export class Spend {
  private total = 0;
  constructor(readonly cap: number) {}
  /** `charged` is what the endpoint says it billed, when it says; the price table is the fallback. */
  add(judge: Judge, promptTokens: number, completionTokens: number, charged?: number) {
    this.total += typeof charged === 'number' && Number.isFinite(charged)
      ? charged
      : (promptTokens * judge.price.input + completionTokens * judge.price.output) / 1e6;
    if (this.total > this.cap) throw new Error(`judge spend ${this.total.toFixed(2)} passed the cap of ${this.cap}`);
  }
  get spent() { return this.total; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How many endpoint failures one judge call waits out, backing off to a minute. */
export const ENDPOINT_RETRIES = 8;

/** Required keys, checked the way the stages need them - shallow, and on array items. */
export type Check<T> = (v: unknown) => v is T;

export async function ask<T>(
  judge: Judge, system: string, user: string, schema: object, check: Check<T>, spend: Spend,
): Promise<T> {
  // An accepted reply is kept under a hash of everything that shaped it, so a rerun
  // after any interruption reuses every call already paid for.
  const cacheDir = process.env.BENCH_JUDGE_CACHE;
  const cachePath = cacheDir && join(cacheDir,
    `${createHash('sha256').update(JSON.stringify([judge.model, judge.extra ?? null, system, user, schema])).digest('hex')}.json`);
  if (cachePath && existsSync(cachePath)) {
    const cached: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (check(cached)) return cached;
  }
  let messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let format: Record<string, unknown> = { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema } };
  let lastErr = '';
  // Endpoint failures - rate limits, outages - are waited out on their own budget:
  // they say nothing about the judge's answer, so they neither spend an answer
  // attempt nor raise the output budget.
  let outages = 0;
  const outage = async (why: string) => {
    if (++outages > ENDPOINT_RETRIES) throw new Error(`${judge.name}: endpoint failed ${outages - 1} times - ${why}`);
    await sleep(Math.min(60_000, 10_000 * outages));
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${judge.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${judge.key}` },
      body: JSON.stringify({
        model: judge.model, temperature: 0, max_tokens: (judge.maxTokens ?? 16_384) * (attempt + 1),
        messages, response_format: format, ...judge.extra,
      }),
    });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) { await outage(`${res.status}: ${text.slice(0, 160)}`); attempt--; continue; }
    if (res.status === 400 && format.type === 'json_schema' && /response_format|json_schema|schema/i.test(text)) {
      // The endpoint will not enforce the schema, so show it instead.
      format = { type: 'json_object' };
      messages = withSchema(messages, schema);
      attempt--;
      continue;
    }
    if (!res.ok) throw new Error(`${judge.name} ${res.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { error?: unknown; choices?: { message?: { content?: string }; finish_reason?: string; error?: unknown }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
    spend.add(judge, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0, j.usage?.cost);
    const choice = j.choices?.[0];
    // A provider failure or an upstream rate limit can arrive as a 200 with the error
    // in the body. It is the endpoint's, not the judge's: wait as for a 5xx rather
    // than retry at once.
    if (j.error || choice?.finish_reason === 'error') {
      await outage(`provider error in a 200 reply: ${JSON.stringify(j.error ?? choice?.error ?? null).slice(0, 160)}`);
      attempt--;
      continue;
    }
    const value = salvageJson(choice?.message?.content ?? '');
    if (check(value)) {
      if (cachePath) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cachePath, JSON.stringify(value)); }
      return value;
    }
    lastErr = `unusable reply (finish=${choice?.finish_reason ?? '?'}): ${String(choice?.message?.content ?? '').slice(0, 120)}`;
    // A rejected reply was paid for; keep it whole so the rejection can be diagnosed.
    if (process.env.BENCH_UNUSABLE_DIR) {
      mkdirSync(process.env.BENCH_UNUSABLE_DIR, { recursive: true });
      writeFileSync(join(process.env.BENCH_UNUSABLE_DIR, `${judge.name}-${Date.now()}.txt`),
        `${user.slice(-4000)}\n\n===== response =====\n${JSON.stringify({ ...j, choices: j.choices?.map((ch) => ({ ...ch, message: { ...ch.message, content: undefined } })) })}`
        + `\n\n===== reply =====\n${choice?.message?.content ?? ''}`);
    }
  }
  throw new Error(`${judge.name} gave no usable verdict after 4 attempts - ${lastErr}`);
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
