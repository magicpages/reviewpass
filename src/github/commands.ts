import { envAny } from '../config/index.js';
/**
 * Chat commands.
 *
 * A review is a conversation, not a broadcast. Most durable review knowledge
 * originates the same way: a maintainer replying to a
 * finding. Without a reply path there is nothing to learn from, so this is not
 * a convenience feature — it is how the reviewer improves.
 */

export type CommandName =
  | 'review'
  | 'full-review'
  | 'resolve'
  | 'ignore'
  | 'resume'
  | 'help'
  | 'agree'
  | 'disagree';

export interface ParsedCommand {
  name: CommandName;
  /** Free text after the command, used when teaching a learning. */
  argument: string;
}

/**
 * The name the bot answers to.
 *
 * Derived from the identity it posts under, because that is the name a person
 * reading the thread will type. An installation that registered its App as
 * `acme-review` posts as `acme-review[bot]` and answers to `@acme-review`;
 * nothing here should be hardcoded to the name this project happens to use.
 *
 * `REVIEWPASS_MENTION` overrides it, and the default only applies when there is
 * no identity to derive from — a local run, or the default token.
 */
export function mentionName(login?: string): string {
  const fromLogin = login?.replace(/\[bot\]$/, '').trim();
  return envAny('MENTION') ?? (fromLogin || 'reviewpass');
}

const LEGACY_BOT = 'warren';

/**
 * Recognised forms: `@reviewpass review`, `@reviewpass full review`, and a bare
 * `@reviewpass <text>` which is treated as a correction to learn from. The
 * previous name is still accepted so open pull requests keep working.
 */
export function parseCommand(body: string, login?: string): ParsedCommand | null {
  const bot = mentionName(login);
  // Escaped: an App slug is user-chosen and may contain regex metacharacters.
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`@(?:${esc(bot)}|${LEGACY_BOT})\\b[ \\t]*(.*)`, 'i');
  const m = mention.exec(body);
  if (!m) return null;

  const rest = (m[1] ?? '').trim();
  const lower = rest.toLowerCase();

  if (/^full[\s-]?review\b/.test(lower)) return { name: 'full-review', argument: '' };
  if (/^re-?review\b|^review\b/.test(lower)) return { name: 'review', argument: '' };
  if (/^resolve\b/.test(lower)) return { name: 'resolve', argument: '' };
  if (/^(ignore|pause|stop)\b/.test(lower)) return { name: 'ignore', argument: '' };
  if (/^resume\b/.test(lower)) return { name: 'resume', argument: '' };
  if (/^help\b|^\?$/.test(lower)) return { name: 'help', argument: '' };

  // A reply on a finding thread is a verdict on that finding.
  if (/\b(agreed?|good catch|fixed|will fix|done)\b/.test(lower)) return { name: 'agree', argument: rest };
  if (/\b(disagree|wrong|incorrect|false positive|not a (bug|problem|issue)|intentional|by design|works as intended)\b/.test(lower)) {
    return { name: 'disagree', argument: rest };
  }

  return rest ? { name: 'agree', argument: rest } : { name: 'help', argument: '' };
}

export function helpText(login?: string): string {
  const BOT = mentionName(login);
  return `**${BOT} commands**

| Command | What it does |
|:---|:---|
| \`@${BOT} review\` | Review the commits added since the last review |
| \`@${BOT} full review\` | Re-review the entire pull request from scratch |
| \`@${BOT} resolve\` | Resolve all open threads |
| \`@${BOT} ignore\` | Stop reviewing this pull request |
| \`@${BOT} resume\` | Start reviewing it again |

Replying to a finding teaches reviewpass. Say why it is wrong and it will not raise
that finding again in this repository; confirm it and the reasoning is kept for
similar code.`;
}

/** The default-name help, for callers with no identity to hand. */
export const HELP_TEXT = helpText();

/**
 * Turn a maintainer's correction into a durable learning. Kept deliberately
 * literal — paraphrasing a correction is how a memory store poisons itself.
 */
export function learningFromReply(
  reply: string,
  finding: { path: string; title: string },
  login?: string,
): string {
  const bot = mentionName(login).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = reply
    .replace(new RegExp(`@(?:${bot}|${LEGACY_BOT})\\b`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim();
  return `In \`${finding.path}\`: regarding "${finding.title}" — ${cleaned}`;
}

/**
 * A command, or nothing. Deliberately stricter than `parseCommand`.
 *
 * `parseCommand` treats any text after the mention as a correction to learn
 * from, which is right when someone is replying to a finding and wrong when
 * they are talking *about* the reviewer. "Ohh I saw that @reviewpass added a
 * review earlier" ends with a mention followed by prose, and prose fell through
 * to a branch that kept going and ran a full re-review.
 *
 * So an instruction has to look like one:
 *
 *   - the mention starts the comment, or starts a line within it. A mention in
 *     the middle of a sentence is someone talking about the bot, not to it.
 *   - the first word after it is a command. Not "probably a command" - one of
 *     these words, and nothing else is entertained.
 *
 * Everything else returns null and the caller moves on. The cost of being wrong
 * here is a review nobody asked for, so the bar is the strict one.
 */
export function parseDirective(body: string, login?: string): ParsedCommand | null {
  const bot = mentionName(login).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^[ \\t]*@(?:${bot}|${LEGACY_BOT})\\b[ \\t]*(.*)$`, 'im');
  const m = line.exec(body);
  if (!m) return null;

  const rest = (m[1] ?? '').trim().toLowerCase();
  if (/^full[\s-]?review\b/.test(rest)) return { name: 'full-review', argument: '' };
  if (/^re-?review\b/.test(rest)) return { name: 'review', argument: '' };
  if (/^review\b/.test(rest)) return { name: 'review', argument: '' };
  if (/^resolve\b/.test(rest)) return { name: 'resolve', argument: '' };
  if (/^(ignore|pause|stop)\b/.test(rest)) return { name: 'ignore', argument: '' };
  if (/^resume\b/.test(rest)) return { name: 'resume', argument: '' };
  if (/^(help|\?)$/.test(rest) || /^help\b/.test(rest)) return { name: 'help', argument: '' };
  return null;
}
