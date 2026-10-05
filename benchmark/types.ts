/**
 * Types for the reviewer benchmark.
 *
 * The method follows one that survives its own scrutiny: several runs per way
 * of reviewing, on pull requests frozen at a commit; a reference built from the
 * union of everything any run found plus the pull request's history, grouped
 * by cause and judged blind; and a hit counted only when a finding names the
 * mechanism of a reference defect. A reference built this way is a lower bound,
 * never the full set of defects - anything no run and no reviewer ever raised
 * is missing from it.
 *
 * No case data lives in this directory. Cases, checkouts and results are
 * written under eval/, which is not committed.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** One pull request frozen at a commit: what every method is run against. */
export interface Case {
  id: string;
  title: string;
  body: string;
  /** The merge base, so the diff is the pull request's and not the branch's. */
  base: string;
  head: string;
  /** A checkout at `head` with no installed dependencies, as in production. */
  workspace: string;
  size: { files: number; added: number; removed: number; diffBytes: number };
  /** Findings the pull request's history already settled: candidates, not ground truth. */
  history: HistoryItem[];
}

export interface HistoryItem {
  path: string;
  line: number;
  title: string;
  body: string;
  /** What happened to it afterwards, e.g. "Fixed in 384964f". */
  reason: string;
  outcome: 'accepted' | 'declined';
}

/** A finding as any method reports it, normalised so methods can be compared. */
export interface BenchFinding {
  /** Stable across stages: `<case>/<method>/<run>/<n>` or `<case>/history/<n>`. */
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  title: string;
  body: string;
  /**
   * What the method knew about the finding, for scoring filters afterwards.
   * Never shown to a judge: judging stays blind to severity, confidence and
   * how many samples agreed.
   */
  meta?: FindingMeta;
}

export interface FindingMeta {
  severity?: string;
  category?: string;
  importance?: number;
  confidence?: number;
  verdictReason?: string;
  /** Which find samples raised it (reviewpass only). */
  samples?: number[];
  /**
   * Where reviewpass put a verified finding: posted inline, listed in the review
   * body, or not posted. A run records all three, so a benchmark can score what
   * verification kept and what the author is shown separately.
   */
  tier?: 'inline' | 'listed' | 'dropped';
}

/** One run of one method on one case. */
export interface Run {
  caseId: string;
  method: string;
  run: number;
  /** What the method reports. For reviewpass: what survived verification. */
  findings: BenchFinding[];
  /** reviewpass only: what the verifier removed, kept to measure the verifier. */
  refuted: BenchFinding[];
  wallMs: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * reviewpass only: files the model itself failed on - a malformed or empty
   * reply. Production leaves such a file unreviewed, so the run stands as the
   * method's result and the count is reported beside it.
   */
  failedFiles?: number;
  /** Set when the run failed. A failed run scores nothing and is reported, never skipped. */
  error?: string;
}

/** Findings the grouping judge considers the same defect: same file, same mechanism. */
export interface Cause {
  id: string;
  caseId: string;
  path: string;
  /** BenchFinding ids. */
  members: string[];
  /** The mechanism in one or two sentences, written by the grouping judge. */
  mechanism: string;
}

export interface Verdict {
  judge: string;
  defect: boolean;
  severity: Severity;
  reason: string;
}

/** A cause once judged: a defect of some severity, or not a defect. */
export interface ReferenceEntry extends Cause {
  defect: boolean;
  severity: Severity;
  verdicts: Verdict[];
  /** Whether the two blind judges agreed, or a third settled it. */
  settledBy: 'agreement' | 'tiebreak';
}
