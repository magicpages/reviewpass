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

// The mention the bot answers to. Configurable because an installation may post
// under its own account name; the previous name stays accepted so commands on
// open pull requests keep working.
const BOT = envAny('MENTION') ?? 'reviewpass';
const LEGACY_BOT = 'warren';

/**
 * Recognised forms: `@reviewpass review`, `@reviewpass full review`, and a bare
 * `@reviewpass <text>` which is treated as a correction to learn from. The
 * previous name is still accepted so open pull requests keep working.
 */
export function parseCommand(body: string): ParsedCommand | null {
  const mention = new RegExp(`@(?:${BOT}|${LEGACY_BOT})\\b[ \\t]*(.*)`, 'i');
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

export const HELP_TEXT = `**reviewpass commands**

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

/**
 * Turn a maintainer's correction into a durable learning. Kept deliberately
 * literal — paraphrasing a correction is how a memory store poisons itself.
 */
export function learningFromReply(
  reply: string,
  finding: { path: string; title: string },
): string {
  const cleaned = reply
    .replace(new RegExp(`@(?:${BOT}|${LEGACY_BOT})\\b`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim();
  return `In \`${finding.path}\`: regarding "${finding.title}" — ${cleaned}`;
}
