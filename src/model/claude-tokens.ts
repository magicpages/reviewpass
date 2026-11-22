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
 * A token at its limit is set aside until the reset the CLI names, in a local
 * wall-clock phrase ("resets 4pm (Europe/Vienna)"), plus a minute. A phrase it
 * cannot place parks the token for an hour: too long a guess keeps a token idle
 * after it is back, too short a one costs one quick refused call and a new mark.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOUR = 3_600_000;

/** How long a token is set aside when the refusal names no reset time. */
export const COOLDOWN = { limit: HOUR, auth: 6 * HOUR } as const;

/** After a named reset, so a call does not race the subscription's own clock. */
const RESET_MARGIN = 60_000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** A wall-clock date in `tz`, from an instant. */
function wallDate(instant: number, tz: string): { y: number; m: number; d: number; wd: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  return { y: +parts.year!, m: +parts.month! - 1, d: +parts.day!, wd: WEEKDAYS.indexOf(parts.weekday!.toLowerCase()) };
}

/** The instant a wall-clock time in `tz` happens; checked twice for a DST change in between. */
function zoned(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const want = Date.UTC(y, m, d, h, min);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(t).map((x) => [x.type, x.value]));
    t += want - Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
  }
  return t;
}

/**
 * When a limit named in a CLI refusal resets: "resets 4pm (Europe/Vienna)",
 * "resets 6:30am (UTC)", optionally after a day ("resets Nov 28, 6pm (…)",
 * "resets Fri 12am (…)"). The next such moment within a week, or undefined when
 * the phrase is missing or names no zone this runtime knows.
 */
export function resetAt(message: string, now: number): number | undefined {
  const m = /resets\s+(?:([a-z]{3})[a-z]*\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)\s]+)\)/i.exec(message);
  if (!m) return undefined;
  const [, word, day, hour, minute, ampm, tz] = m;
  const month = word && day ? MONTHS.indexOf(word.toLowerCase()) : -1;
  const weekday = word && !day ? WEEKDAYS.indexOf(word.toLowerCase()) : -1;
  if (word && month < 0 && weekday < 0) return undefined;
  const h = (+hour! % 12) + (ampm!.toLowerCase() === 'pm' ? 12 : 0);
  try {
    for (let i = 0; i <= 7; i++) {
      const w = wallDate(now + i * 24 * HOUR, tz!);
      if (month >= 0 && (w.m !== month || w.d !== +day!)) continue;
      if (weekday >= 0 && w.wd !== weekday) continue;
      const at = zoned(w.y, w.m, w.d, h, +(minute ?? 0), tz!);
      if (at > now) return at;
    }
  } catch { /* an unknown time zone */ }
  return undefined;
}

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
  /** This process's own marks, which hold even when the file cannot be written. */
  private readonly local: State = {};

  constructor(tokens: string[], private readonly statePath: string, private readonly now: () => number = Date.now) {
    this.tokens = tokens.map((token) => ({ id: tokenId(token), token }));
  }

  private read(): State {
    let file: State = {};
    try { file = JSON.parse(readFileSync(this.statePath, 'utf8')) as State; } catch { /* no marks yet */ }
    const out: State = { ...file };
    for (const [id, mark] of Object.entries(this.local)) if ((out[id]?.until ?? 0) < mark.until) out[id] = mark;
    return out;
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
   * Set a token aside: until the reset `message` names, or for its kind's
   * cooldown. Read, merged and replaced in one rename, so two reviews marking at
   * once at worst lose one mark - which costs one refused call. A file that
   * cannot be written (read-only, disk full) only loses the sharing: the mark
   * still holds in this process.
   */
  setAside(id: string, kind: keyof typeof COOLDOWN, message = ''): void {
    const now = this.now();
    const reset = kind === 'limit' ? resetAt(message, now) : undefined;
    this.local[id] = { until: reset !== undefined ? reset + RESET_MARGIN : now + COOLDOWN[kind], why: kind };
    const state = this.read();
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch (err) {
      try { rmSync(tmp, { force: true }); } catch { /* the directory itself is the problem */ }
      console.error(`  claude token state not saved to ${this.statePath} (${(err as Error).message}); other reviews will not skip token ${id}`);
    }
  }
}
