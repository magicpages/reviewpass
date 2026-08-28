import type { Rebuttal } from '../github/client.js';

/**
 * Answering a maintainer who pushed back on a finding.
 *
 * The measured need for this: on one 22-file pull request the reviewer posted
 * 25 findings and drew 11 rebuttals, and every one of the 11 was right. Two
 * thirds of the loss had a single cause - the reviewer had not read the code
 * that settled the question, and the maintainer had. Those threads then sat
 * open, because nothing in the tool could answer.
 *
 * The asymmetry is the whole design. Someone who wrote the change and went and
 * checked knows more than a reviewer working from a window of it, so the
 * default is to concede. Holding is reserved for the case where the reply is
 * checkably wrong about the code - not where it is merely unwelcome.
 *
 * Conceding is also the only way a rejection is recorded, so a finding argued
 * down once is not raised again on the next pull request.
 */

export const RESPONDER_SYSTEM = `You are answering a maintainer who replied to one of your code review findings.

They wrote the change and have read the code. You are working from a window of
it. When your reading and theirs disagree, they are usually right, and the
useful reply is a short concession that says precisely what you got wrong.

## Concede when
- they point at code that settles it — a wrapper that already validates, a
  guard a few lines up, a call that cannot be reached
- the fix conflicts with a convention the file or repository already follows
- they fixed it, or explained why the shape you asked for would be wrong
- you cannot show, from the code in front of you, that they are mistaken

## Hold only when
you can point to the specific line that contradicts them. Not "it may still be
possible" — the line. If the strongest thing you have is that their argument
might not cover every case, concede: an unfalsifiable objection is not evidence,
and pressing one wastes a reviewer's credibility on the findings that are real.

## Writing the reply
Two or three sentences. Say what you now understand, not what you feel about it.

- Conceding: name the thing you missed. "Missed that the client wrapper trims
  before sending — the validation is a layer down from where I was reading." That
  sentence is the whole value of the exchange, because it is what stops the
  same finding coming back.
- Holding: quote the line and say what it does. Then stop.

No apologies, no thanks, no restating their argument back to them, no closing
pleasantries. They are reading this in a diff, between other work.

Never propose new findings here. A thread about one finding is not an opening
to raise another.`;

export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Every property, not just the conceptually required ones: strict
  // `json_schema` rejects a schema where `additionalProperties` is false and a
  // declared property is absent from `required`. `contradicting_line` is
  // meaningful only when holding, so the prompt asks for an empty string
  // otherwise rather than for the field to be omitted.
  required: ['concede', 'reply', 'confidence', 'contradicting_line'],
  properties: {
    concede: {
      type: 'boolean',
      description: 'True to withdraw the finding. Default to true unless a specific line disproves them.',
    },
    reply: { type: 'string', description: 'Two or three sentences, posted verbatim into the thread.' },
    confidence: { type: 'number', description: '0 to 1.' },
    // Only meaningful when holding; requiring it is what makes holding cost something.
    contradicting_line: {
      type: 'string',
      description: 'When holding, the exact line of code that contradicts the reply. Empty when conceding.',
    },
  },
} as const;

export function buildRespondPrompt(
  r: Rebuttal,
  fileText: string | undefined,
  namedFiles: { label: string; text: string }[],
  pr?: { title: string; body: string },
): string {
  const numbered = fileText
    ? fileText.split('\n').map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join('\n')
    : '';

  return [
    pr?.title ? `# What this pull request is trying to do\n\n${pr.title}\n` : '',
    '# The finding you posted',
    `On \`${r.path}\`${r.line ? ` line ${r.line}` : ''}:`,
    '',
    r.finding.slice(0, 3_000),
    '',
    '# What they replied',
    ...r.replies.map((c) => `**${c.author}:**\n\n${c.body.slice(0, 3_000)}`),
    '',
    numbered ? `# \`${r.path}\` as it now stands\n\n\`\`\`\n${numbered.slice(0, 60_000)}\n\`\`\`` : '',
    // The reply usually names the file that settles the question - "the wrapper
    // in `src/lib/client.ts` already trims" - and not fetching it is how the
    // finding came to be wrong in the first place.
    namedFiles.length
      ? `\n# Files their reply refers to\n\n${namedFiles
          .map((n) => `## ${n.label}\n\n\`\`\`\n${n.text.slice(0, 6_000)}\n\`\`\``).join('\n\n')}`
      : '',
    '',
    '# Task',
    'Decide whether to concede or hold, and write the reply. Return JSON matching the schema.',
  ].filter(Boolean).join('\n');
}

export interface Response {
  concede: boolean;
  reply: string;
  confidence: number;
}

/**
 * A model that cannot name the contradicting line has not found one.
 *
 * Without this the hold path is free: "I still think this could be a problem"
 * satisfies any schema and reads as a considered judgement. Requiring the line
 * makes holding cost something, which is the only reason the default toward
 * conceding survives contact with a model that would rather be right.
 */
export function settleResponse(
  raw: { concede: boolean; reply: string; confidence?: number; contradicting_line?: string },
  fileText: string | undefined,
  log: (m: string) => void = () => {},
): Response {
  const confidence = Math.max(0, Math.min(1, raw.confidence ?? 0.5));
  if (raw.concede) return { concede: true, reply: raw.reply.trim(), confidence };

  const line = (raw.contradicting_line ?? '').trim();
  if (!line) {
    log('  holding without a cited line; conceding instead');
    return { concede: true, reply: raw.reply.trim(), confidence };
  }
  // The line has to exist. Whitespace is normalised because a model retyping a
  // line from memory reproduces its content and not its indentation.
  if (fileText) {
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (!flat(fileText).includes(flat(line))) {
      log(`  holding on a line that is not in the file: ${line.slice(0, 60)}`);
      return { concede: true, reply: raw.reply.trim(), confidence };
    }
  }
  return { concede: false, reply: raw.reply.trim(), confidence };
}
