/** Everything that crosses a module boundary in reviewpass. */

export type Severity = 'critical' | 'major' | 'minor' | 'trivial';

/**
 * Categories are the ones a reviewer actually needs to separate, because those are
 * the ones the acceptance data is measured against.
 */
export type Category =
  | 'correctness'
  | 'security'
  | 'data'             // 🗄️ Data Integrity & Integration
  | 'stability'
  | 'performance'      // 🚀 Performance & Scalability
  | 'maintainability';

export interface Site {
  path: string;
  startLine: number;
  endLine: number;
}

export interface Finding {
  /** Anchor: where the comment gets posted. */
  path: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  /** A ready-to-commit replacement for the anchored lines, if one applies. */
  suggestion?: string;
  /** Other places the same defect reaches, reported once rather than N times. */
  siblings?: Site[];
  /** Stable identity, so an incremental review does not repeat itself. */
  fingerprint?: string;
  /** Populated by the verification pass. */
  verdict?: 'upheld' | 'refuted';
  verdictReason?: string;
  /** 1-5 from the verifier: how much this earns the author's attention. */
  importance?: number;
  confidence?: number;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
  patch?: string;
  /** Line ranges present in the new file, used to keep comments on the diff. */
  addedLines: number[];
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  files: ChangedFile[];
  /** Commits reviewed in this pass: the whole PR, or only what is new. */
  reviewedFrom: string;
  reviewedTo: string;
  isIncremental: boolean;
  linkedIssues: number[];
  /**
   * What the linked issues say, when they are readable.
   *
   * The strongest statement of intent a change usually has, and the one thing
   * that separates "this code is self-consistent" from "this code does what was
   * asked". A review that never reads it can only check the change against
   * itself.
   */
  intent?: { source: string; title: string; body: string }[];
}

export interface ReviewUnit {
  path: string;
  file: ChangedFile;
  /** Prose context assembled by the context engine for this file. */
  context: string;
  /**
   * The anchored file in full, when it is small enough to send. The verifier
   * decides factual claims - "this import is unused", "this is never reset" -
   * and a window cannot settle them: the use it is looking for may sit thirty
   * lines outside it. Measured, the windowed verifier upheld "remove the unused
   * `Link` import" at confidence 1.0 with the four uses just off-screen.
   */
  fileText?: string;
  /**
   * Files a finding under verification names, resolved and read. Claims about
   * somewhere else are the ones that go wrong, and the anchored file cannot
   * settle them.
   */
  namedFiles?: { label: string; text: string }[];
  instructions: string[];
  learnings: string[];
  toolFindings: string[];
  /**
   * Whether static analysis actually ran. An empty `toolFindings` means "clean"
   * only if this is true; otherwise it means the toolchain never executed, and
   * telling the verifier the checker was green would refute real findings on
   * the strength of a run that never happened.
   */
  toolsRan?: boolean;
  /** Whether the compiler is enforcing the types this file declares. */
  strictness?: { strictNullChecks: boolean; noUncheckedIndexedAccess: boolean };
}

export interface PreMergeCheck {
  name: string;
  status: 'passed' | 'warning' | 'failed';
  explanation: string;
  resolution?: string;
}

export interface ReviewResult {
  findings: Finding[];
  walkthrough: string;
  fileGroups: { label: string; summary: string; files: string[] }[];
  effort: { score: number; label: string };
  mergeRisk: 'minimal' | 'low' | 'moderate' | 'high';
  checks: PreMergeCheck[];
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  skipped: { path: string; reason: string }[];
  /**
   * How much of the review actually happened.
   *
   * Carried so the summary cannot claim a clean review that never ran. An
   * exhausted model account failed every file on a live pull request and the
   * review still said "Nothing to raise" with a green check.
   */
  reviewedFiles?: number;
  failedFiles?: number;
  /** Findings from earlier passes still awaiting an answer. */
  openFindings?: number;
  /** Set when nothing could be reviewed for a reason the author cannot fix. */
  blocked?: { message: string };
}
