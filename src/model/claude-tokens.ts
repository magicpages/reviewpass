/**
 * Several Claude subscription tokens, used in order, each set aside while it is
 * at its limit.
 *
 * The first token serves every call until the subscription refuses one; that
 * token is then marked exhausted for a while and the call goes to the next. The
 * marks live in a small state file, so the other reviews on the same machine -
 * self-hosted runners share one user - skip a spent token instead of each
 * finding out with a failed call. Tokens are known by a short hash only: no
 * token is written to the file or to a log.
 *
 * How long a token is set aside is a guess on purpose. The CLI says when a limit
 * resets in a local wall-clock phrase ("resets 11pm (Europe/Vienna)"); rather
 * than parse that, a session limit parks the token for an hour and a weekly one
 * for twelve. A guess that is too short costs one quick refused call and a fresh
 * mark.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOUR = 3_600_000;

/** How long a token is set aside after each kind of refusal. */
export const COOLDOWN = { session: HOUR, weekly: 12 * HOUR, auth: 6 * HOUR } as const;

type State = Record<string, { until: number; why: string }>;

export interface PoolToken {
  /** A short hash of the token, for the state file and logs. */
  id: string;
  token: string;
}

/** `REVIEWPASS_CLAUDE_TOKENS`: one token per line or comma-separated. */
export function parseTokens(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean))];
}

export const tokenId = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 8);

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'reviewpass', 'claude-tokens.json');
}

export class ClaudeTokenPool {
  readonly tokens: PoolToken[];

  constructor(tokens: string[], private readonly statePath: string, private readonly now: () => number = Date.now) {
    this.tokens = tokens.map((token) => ({ id: tokenId(token), token }));
  }

  private read(): State {
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')) as State; } catch { return {}; }
  }

  /** The first token not set aside, or undefined when every one is. */
  pick(skip: ReadonlySet<string> = new Set()): PoolToken | undefined {
    const state = this.read();
    const t = this.now();
    return this.tokens.find((k) => !skip.has(k.id) && (state[k.id]?.until ?? 0) <= t);
  }

  /** When the soonest set-aside token is due back, for the message when none is left. */
  nextFree(): number | undefined {
    const state = this.read();
    const times = this.tokens.map((k) => state[k.id]?.until ?? 0).filter((u) => u > this.now());
    return times.length ? Math.min(...times) : undefined;
  }

  /**
   * Set a token aside. Read, merged and replaced in one rename, so two reviews
   * marking at once at worst lose one mark - which costs one refused call.
   */
  setAside(id: string, kind: keyof typeof COOLDOWN): void {
    const state = this.read();
    state[id] = { until: this.now() + COOLDOWN[kind], why: kind };
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
}

/** Which limit a refusal names: the weekly one parks a token far longer. */
export const limitKind = (message: string): 'session' | 'weekly' => (/weekly/i.test(message) ? 'weekly' : 'session');
