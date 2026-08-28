/**
 * Parse a tsconfig, which is JSON with comments and trailing commas.
 *
 * Written because the obvious approach is wrong in a way that hides itself. A
 * regex that strips `/* ... *' + '/` cannot tell a comment from a path alias:
 * `"@/lib/*"` contains a slash followed by an asterisk, so stripping begins
 * inside a string and runs to the next `*` + `/`, which any `**' + '/*.ts` in an
 * `include` array supplies. On a real monorepo config this deleted 1180 of 1711
 * characters and left something that could not be parsed.
 *
 * Nothing reported the failure, because both callers treat a parse error as
 * "no tsconfig here" and fall back to convention. Path aliases silently stopped
 * resolving, and the strictness of the project read as false on a project that
 * sets `strict` three times over.
 *
 * So: a scanner that knows what a string is. Slower than a regex and correct.
 */
export function parseJsonc<T>(text: string): T | undefined {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') { inString = true; out += c; continue; }

    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // land on the '/', the loop increment steps past it
      continue;
    }
    out += c;
  }

  // Trailing commas, which tsconfig allows and JSON does not.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out) as T;
  } catch {
    return undefined;
  }
}
