import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { globToRegExp } from './select.js';

/**
 * Instruction mining.
 *
 * Agent instruction files are the richest source of a repository's conventions
 * that a reviewer can read without being told — CLAUDE.md alone produces
 * 149 distinct rules. Teams have already written down how their code should
 * look; a reviewer that ignores those files is throwing away its best context.
 */

export interface Rule {
  /** Glob the rule applies to, or '**' for repo-wide. */
  scope: string;
  text: string;
  source: string;
}

/** Files worth mining, in descending order of how specific they usually are. */
const INSTRUCTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  'CONTRIBUTING.md',
  '.reviewpass/rules.md',
  '.warren/rules.md',
];

/** Directories where projects keep per-topic rule files. */
const RULE_DIRS = ['.claude/rules', '.cursor/rules', '.github/instructions', '.reviewpass/rules', '.warren/rules'];

/**
 * A rule file that only applies in certain situations.
 *
 * Repositories increasingly split their conventions into topic files and route
 * to them from a table in CLAUDE.md, e.g.
 *
 *   | `.claude/rules/logging.md` | Any `logger.*` call — ECS structure, PII redaction |
 *
 * Reading only CLAUDE.md therefore misses the actual rules. Worse, loading them
 * all indiscriminately buries the relevant ones: a review of a service file does
 * not need the design-system rules. So each file is gated on a trigger taken
 * from that table, matched against the diff.
 */
interface RuleFile {
  path: string;
  /** Identifiers whose presence in the change means this file applies. */
  triggers: string[];
  /** Paths this file applies to, when the routing entry names one. */
  globs: string[];
}

/** Headings that mean "this section is not a rule". */
const NON_RULE_HEADING = /^(license|licence|changelog|table of contents|acknowledge|credits|installation|getting started|screenshots?)\b/i;

/**
 * A line reads as a rule when it is imperative or normative. This is
 * deliberately conservative: a false rule becomes a false finding.
 */
const NORMATIVE = /\b(must|never|always|do not|don't|should|require[ds]?|prefer|avoid|ensure|use\b|only\b|forbidden|mandatory)\b/i;

function ruleLines(md: string, source: string, scope: string): Rule[] {
  const out: Rule[] = [];
  let skipping = false;
  let inFence = false;

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { skipping = NON_RULE_HEADING.test(heading[1]!.trim()); continue; }
    if (skipping) continue;

    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+\.\s+(.*)$/.exec(line);
    const text = (bullet?.[1] ?? line).trim();
    if (text.length < 12 || text.length > 400) continue;
    if (!NORMATIVE.test(text)) continue;
    // Drop markdown links-only lines and badges.
    if (/^!?\[[^\]]*\]\([^)]*\)$/.test(text)) continue;

    out.push({ scope, text: text.replace(/\s+/g, ' '), source });
  }
  return out;
}

/**
 * Mine instruction files across the repo. A nested AGENTS.md scopes its rules to
 * its own directory, which is how monorepos express per-package conventions.
 */
/** Parse the `| \`path\` | when it applies |` routing table, if there is one. */
export function parseRuleRouting(md: string): Map<string, { triggers: string[]; globs: string[] }> {
  const out = new Map<string, { triggers: string[]; globs: string[] }>();
  for (const line of md.split('\n')) {
    const row = /^\|\s*`([^`]+\.mdc?)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line.trim());
    if (!row) continue;
    const when = row[2]!;
    const triggers: string[] = [];
    const globs: string[] = [];
    // Backticked tokens in the "when" column are the concrete signals.
    for (const m of when.matchAll(/`([^`]+)`/g)) {
      const tok = m[1]!;
      if (tok.includes('/') || tok.startsWith('*')) globs.push(tok);
      else triggers.push(tok.replace(/[*().]+$/, ''));
    }
    // Fall back to salient words so a prose-only entry still gates on something.
    if (!triggers.length && !globs.length) {
      for (const w of when.toLowerCase().match(/\b(route|service|test|log|ui|component|deploy|type|naming|issue|pr)\w*/g) ?? []) {
        triggers.push(w);
      }
    }
    out.set(row[1]!, { triggers, globs });
  }
  return out;
}

/**
 * Does this change plausibly involve the rule file's subject?
 *
 * Matching is on whole words: a substring test let the trigger `ui` fire on
 * "build" and "require", which pulled twenty design-system rules into the review
 * of a backend service and crowded out the four that mattered.
 */
function ruleApplies(rf: RuleFile, path: string, patch: string): boolean {
  if (rf.globs.some((g) => globToRegExp(g).test(path))) return true;
  if (!rf.triggers.length) return true;   // ungated: always relevant

  // Only the added lines: a rule should fire on what the change introduces.
  const added = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  const hay = `${path}\n${added}`;

  const usable = rf.triggers.filter((t) => t.trim().length >= 3);
  // Every trigger too short to match safely (`as`, `ui`) means the routing entry
  // cannot gate this file. Include it rather than silently losing its rules —
  // type-assertion rules are among the most frequently violated in practice.
  if (!usable.length) return true;

  return usable.some((t) => {
    const re = new RegExp(`\\b${t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(hay);
  });
}

export function mineInstructions(
  root: string,
  changedPaths: string[],
  /** Diff text per path, used to decide which gated rule files apply. */
  patches: Map<string, string> = new Map(),
): Rule[] {
  const rules: Rule[] = [];
  const seen = new Set<string>();

  const consider = (rel: string, scope: string) => {
    const abs = join(root, rel);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    try {
      rules.push(...ruleLines(readFileSync(abs, 'utf8'), rel, scope));
    } catch {
      // An unreadable instruction file is not worth failing a review over.
    }
  };

  for (const f of INSTRUCTION_FILES) consider(f, '**');

  // Directory-local instruction files, walking up from each changed file.
  const dirs = new Set<string>();
  for (const p of changedPaths) {
    let d = dirname(p);
    while (d && d !== '.' && d !== '/') { dirs.add(d); d = dirname(d); }
  }
  for (const d of dirs) {
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
      consider(join(d, f), `${d}/**`);
    }
  }

  // Topic rule files, gated on the routing table so only the relevant ones load.
  const routing = new Map<string, { triggers: string[]; globs: string[] }>();
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    try {
      for (const [k, v] of parseRuleRouting(readFileSync(abs, 'utf8'))) routing.set(k, v);
    } catch {
      // an unparseable table just means the files stay ungated
    }
  }

  const allPatches = [...patches.values()].join('\n');
  for (const dir of RULE_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    let entries: string[];
    try {
      entries = readdirSync(abs).filter((f) => f.endsWith('.md') || f.endsWith('.mdc'));
    } catch {
      continue;
    }
    for (const name of entries) {
      const rel = `${dir}/${name}`;
      const route = routing.get(rel) ?? { triggers: [], globs: [] };
      const rf: RuleFile = { path: rel, triggers: route.triggers, globs: route.globs };

      // Apply if any changed file triggers it; scope to those files when the
      // routing entry named globs, otherwise repo-wide.
      const matching = changedPaths.filter((p) => ruleApplies(rf, p, patches.get(p) ?? allPatches));
      if (!matching.length) continue;

      const scope = rf.globs.length ? rf.globs[0]! : '**';
      consider(rel, scope);
    }
  }

  return dedupe(rules);
}

function dedupe(rules: Rule[]): Rule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const k = r.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The rules that apply to one file: repo-wide plus anything scoped to it.
 *
 * Ordered by specificity, because the prompt shows only the first N and a
 * topic rule file that the change actually triggered is worth more than a
 * general line from CLAUDE.md.
 */
export function rulesFor(rules: Rule[], path: string, extra: { path: string; instructions: string }[] = []): string[] {
  const specificity = (r: Rule): number => {
    if (r.scope !== '**') return 3;                       // path-scoped
    if (/rules\//.test(r.source)) return 2;               // a triggered topic file
    return 1;                                             // general project doc
  };
  const matched = rules
    .filter((r) => r.scope === '**' || globToRegExp(r.scope).test(path))
    .sort((a, b) => specificity(b) - specificity(a))
    .map((r) => `${r.text}  (${r.source})`);

  for (const e of extra) {
    if (globToRegExp(e.path).test(path)) matched.push(`${e.instructions}  (.reviewpass.yaml)`);
  }
  return matched;
}
