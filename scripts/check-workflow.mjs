/**
 * The workflow condition is code that only GitHub can run, and it fails late.
 *
 * A one-paren imbalance shipped in this example and in a live repository, where
 * it silently swallowed the `issue_comment` clause so `@mention` commands could
 * never have matched. It went unnoticed because an unrelated error — a call to
 * a function GitHub does not have — surfaced first and masked it.
 *
 * Both are checkable here in milliseconds, so they are.
 */
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'contains', 'startsWith', 'endsWith', 'format', 'join',
  'toJSON', 'fromJSON', 'hashFiles',
  'success', 'always', 'cancelled', 'failure',
]);

let failed = false;
const fail = (f, m) => { console.error(`  ${f}: ${m}`); failed = true; };

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/^\s*if:\s*>?\s*\n((?:\s{6,}.*\n)+)/gm)) {
    const expr = m[1];
    let depth = 0;
    for (const ch of expr) {
      if (ch === '(') depth++;
      else if (ch === ')' && --depth < 0) fail(file, 'more closing than opening parentheses');
    }
    if (depth !== 0) fail(file, `unbalanced parentheses in an if: condition (depth ${depth})`);
    for (const c of expr.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (!ALLOWED.has(c[1])) fail(file, `\`${c[1]}()\` is not a GitHub Actions expression function`);
    }
  }
}
console.log(failed ? '  workflow check FAILED' : '  workflow conditions look valid');
process.exit(failed ? 1 : 0);
