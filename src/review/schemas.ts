/**
 * JSON schemas handed to llama.cpp. `strict: true` makes the server enforce
 * these as a grammar, so the shapes below are the parse contract — not a hint.
 * Keep every object `additionalProperties: false` and list every key in
 * `required`, which is what strict mode demands.
 */

export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start_line', 'end_line', 'severity', 'category', 'title', 'body', 'suggestion', 'siblings', 'settled_by'],
        properties: {
          start_line: { type: 'integer', description: 'First line of the defect in the NEW file' },
          end_line: { type: 'integer', description: 'Last line of the defect in the NEW file' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'trivial'] },
          category: {
            type: 'string',
            enum: ['correctness', 'security', 'data', 'stability', 'performance', 'maintainability'],
          },
          title: { type: 'string', description: 'One imperative sentence naming the fix' },
          body: { type: 'string', description: 'Why this is wrong and what breaks. 1-4 sentences.' },
          suggestion: {
            type: 'string',
            description: 'Replacement source for exactly the anchored lines, or "" if none applies',
          },
          settled_by: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'line', 'quote'],
            description:
              'The one place in the code that settles this claim, quoted. Not the line you are '
              + 'commenting on - the line that proves you are right about it: the declaration, the '
              + 'caller, the existing test, the guard. Quote it exactly as it appears.',
            properties: {
              path: { type: 'string', description: 'File the quote comes from' },
              line: { type: 'integer', description: 'Line number the quote starts on' },
              quote: { type: 'string', description: 'Text copied verbatim from that line' },
            },
          },
          siblings: {
            type: 'array',
            description: 'Other places the same defect reaches. Empty when it is local.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'start_line', 'end_line'],
              properties: {
                path: { type: 'string' },
                start_line: { type: 'integer' },
                end_line: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['correct', 'in_scope', 'importance', 'disproof', 'reason', 'confidence'],
  properties: {
    // Two axes, because one does not fit the failure. Measured over 60
    // independently labelled candidates, 42% were factually correct but only
    // 22% were worth showing: a fifth of everything raised is *true and still
    // not worth an author's attention*. A single "refuted" flag cannot express
    // that, so trivia sailed through every version of this filter.
    correct: {
      type: 'boolean',
      description:
        'Is the factual claim true of this code? Check it against the file shown. ' +
        'A claim whose premise is false is not correct however reasonable it sounds. ' +
        'Missing context is not grounds to call it false - judge what you can see.',
    },
    in_scope: {
      type: 'boolean',
      // The second half of verification, and the one that was missing. Published
      // analysis of agentic reviews finds rejections driven by three things:
      // invalid, redundant, and *out-of-scope*. Correctness answers the first,
      // dedup the second, and nothing answered the third - so the reviewer
      // reported pre-existing conditions the author did not touch as though the
      // change had caused them.
      description:
        'Does this finding belong on THIS pull request? True when the change ' +
        'introduced the problem, made it reachable, or was the moment to fix it. ' +
        'False when the condition pre-dates the change and the diff merely sits ' +
        'near it, when it concerns unchanged context lines, or when it asks for ' +
        'work the change never claimed to do. A true statement about untouched ' +
        'code is still out of scope.',
    },
    importance: {
      type: 'integer',
      // 1-10, not 1-5. On the narrower scale every verifier tested put almost
      // everything in {1,2,3} and never used the top - so ranking sixteen
      // candidates had three levels and mostly ties, which is no ordering at
      // all when the plan is to post only the best few.
      description:
        'How much this earns the author\'s attention, 1 to 10. Use the whole range; ' +
        'most candidates deserve 2-5 and that is the expected answer. ' +
        '9-10 = would block the merge: data loss, a security hole, a break on a normal path. ' +
        '7-8 = must fix before this ships: wrong behaviour on a path that occurs in practice, ' +
        'or a guarantee the code claims and does not keep. ' +
        '5-6 = a real defect on an edge case; an unhandled failure of something that does fail ' +
        'in production; a test that would pass if the behaviour it names were broken. ' +
        '3-4 = minor, worth saying only if there is little else. ' +
        '1-2 = trivia: restates the code, pure style, an assertion that changes nothing.',
    },
    disproof: {
      type: 'string',
      description: 'The line that settles the factual question, quoted from the code shown. Empty if none.',
    },
    reason: { type: 'string', description: 'One sentence of evidence for the verdict' },
    confidence: { type: 'number', description: '0.0 to 1.0' },
  },
} as const;


/**
 * Verdicts for a group of findings anchored to the same code, judged together.
 *
 * The single-finding schema could not express "these two say the same thing",
 * so two descriptions of one defect were verified independently and returned
 * opposite answers on the same pull request.
 */
export const GROUP_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'correct', 'in_scope', 'importance', 'duplicate_of', 'reason'],
        properties: {
          index: { type: 'integer', description: 'The finding this verdict is for, as numbered above' },
          correct: {
            type: 'boolean',
            description:
              'Is the factual claim true of this code? Judge every finding in the group against the ' +
              'same reading of it - if two findings contradict each other, at most one can be correct.',
          },
          in_scope: {
            type: 'boolean',
            description:
              'Does it belong on THIS pull request? False when the condition pre-dates the change, ' +
              'concerns untouched lines, or argues against what the change set out to do.',
          },
          importance: { type: 'integer', description: 'How much it earns the author\'s attention, 1 to 10.' },
          duplicate_of: {
            type: 'integer',
            description:
              'The index of an earlier finding in this group that reports the SAME underlying defect, ' +
              'even where the wording differs entirely. -1 when this finding stands on its own. ' +
              'Only the original is shown to the author.',
          },
          reason: { type: 'string', description: 'One sentence of evidence for the verdict' },
        },
      },
    },
  },
} as const;

export const WALKTHROUGH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'groups', 'effort_score', 'effort_label', 'merge_risk', 'merge_risk_reason'],
  properties: {
    summary: { type: 'string', description: '2-4 sentences describing what the PR does' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'summary', 'files'],
        properties: {
          label: { type: 'string', description: 'What this cluster of files does, e.g. "Session handling"' },
          summary: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    effort_score: { type: 'integer', description: '1 trivial to 5 critical' },
    effort_label: { type: 'string', enum: ['Trivial', 'Simple', 'Moderate', 'Complex', 'Critical'] },
    merge_risk: { type: 'string', enum: ['minimal', 'low', 'moderate', 'high'] },
    merge_risk_reason: { type: 'string' },
  },
} as const;

export const CHECKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'explanation', 'resolution'],
        properties: {
          name: {
            type: 'string',
            enum: ['Title check', 'Description check', 'Linked issues check', 'Out of scope changes check'],
          },
          status: { type: 'string', enum: ['passed', 'warning', 'failed'] },
          explanation: { type: 'string' },
          resolution: { type: 'string', description: 'How to fix it, or "" when passed' },
        },
      },
    },
  },
} as const;

export interface RawFinding {
  start_line: number;
  end_line: number;
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  category: 'correctness' | 'security' | 'data' | 'stability' | 'performance' | 'maintainability';
  title: string;
  body: string;
  suggestion: string;
  siblings: { path: string; start_line: number; end_line: number }[];
  settled_by?: { path: string; line: number; quote: string };
}
