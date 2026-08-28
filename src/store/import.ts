import { readFileSync } from 'node:fs';
import { LearningStore } from './learnings.js';

/**
 * Importing accumulated review knowledge.
 *
 * A reviewer that starts cold is missing most of what an established one knows:
 * the conventions a team settled years ago, the mistake that keeps recurring,
 * the rule nobody wrote down. This reads that knowledge in from a JSON export so
 * a new installation does not have to relearn it from scratch.
 *
 * The `beforePr` cutoff exists so a benchmark can supply only what was known
 * *before* the pull request under test, which is the honest comparison.
 */

export interface ImportedLearning {
  content: string;
  source_repo?: string | null;
  source_pr?: number | null;
  source_file?: string | null;
  source_lines?: string | null;
  learnt_from?: string | null;
  learnt_at?: string | null;
  injections?: number | null;
}

export interface ImportOptions {
  /** Scope to file them under, e.g. `acme/api` for one repo or `acme/*` for an org. */
  scope: string;
  /** Only import learnings from pull requests numbered below this. */
  beforePr?: number;
  /** Skip entries recalled fewer times than this — a crude quality filter. */
  minInjections?: number;
  /** Keep entries whose origin is unknown. They carry no PR to compare against. */
  includeUndated?: boolean;
}

export interface ImportResult {
  considered: number;
  imported: number;
  skippedByCutoff: number;
  skippedByQuality: number;
}

/**
 * A learning is scoped to the file it came from when it names one. Entries that
 * open with "Applies to <glob>" are path rules lifted from a config file, so the
 * glob is the better scope.
 */
function scopeOf(l: ImportedLearning): { path?: string; glob?: string } {
  const applies = /^Applies to ([^\s:]+)\s*:/.exec(l.content);
  if (applies) return { glob: applies[1] };
  const file = l.source_file?.trim();
  if (file && file !== ':0-0' && !file.startsWith(':')) return { path: file };
  return {};
}

export function importLearnings(
  store: LearningStore,
  file: string,
  opts: ImportOptions,
): ImportResult {
  const all = JSON.parse(readFileSync(file, 'utf8')) as ImportedLearning[];
  const result: ImportResult = {
    considered: all.length, imported: 0, skippedByCutoff: 0, skippedByQuality: 0,
  };

  for (const l of all) {
    if (!l.content || l.content.length < 40) continue;

    if (opts.beforePr !== undefined) {
      if (l.source_pr == null) {
        if (!opts.includeUndated) { result.skippedByCutoff++; continue; }
      } else if (l.source_pr >= opts.beforePr) {
        result.skippedByCutoff++;
        continue;
      }
    }

    if (opts.minInjections && (l.injections ?? 0) < opts.minInjections) {
      result.skippedByQuality++;
      continue;
    }

    const { path, glob } = scopeOf(l);
    if (store.add({
      scope: opts.scope,
      path,
      glob,
      content: l.content,
      source: l.learnt_from ? `learning from ${l.learnt_from}` : 'imported learning',
      sourcePr: l.source_pr ?? undefined,
    })) {
      result.imported++;
    }
  }
  return result;
}
