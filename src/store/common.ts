/**
 * The parts of the learnings store that carry no storage with them.
 *
 * Split out because the SQLite store sits in the same file, and importing a
 * type or a helper from it pulled `better-sqlite3` into the module graph. An
 * ESM bundle resolves its imports before running anything, so a command that
 * never opens a database still failed on a machine without a compiled binding
 * for one.
 */

export interface Learning {
  scope: string;
  path?: string;
  glob?: string;
  content: string;
  source: string;
  sourcePr?: number;
}

export interface RecordedFinding {
  scope: string;
  pr: number;
  headSha: string;
  fingerprint: string;
  path: string;
  startLine: number;
  endLine: number;
  severity: string;
  category: string;
  title: string;
  body: string;
  hadSuggestion: boolean;
  verdict?: string;
  posted: boolean;
}

/** Scopes to search, most specific first: this repo, then the whole org. */
export function scopesFor(owner: string, repo: string): string[] {
  return [`${owner}/${repo}`, `${owner}/*`];
}

/** Minimal glob match for learning scopes. `**` crosses separators. */
export function matchesGlob(glob: string, path: string): boolean {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else { out += '.*'; }
      } else {
        out += '[^/]*';
      }
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  try {
    return new RegExp(`^${out}$`).test(path);
  } catch {
    return false;
  }
}
