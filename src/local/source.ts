import { execFileSync } from 'node:child_process';
import { addedLineNumbers } from '../context/select.js';
import type { ChangedFile, Finding, PullRequestContext } from '../types.js';
import type { ExistingReview, ReviewPlan } from '../github/client.js';

/**
 * A review of local changes, with no pull request behind it.
 *
 * The reviewer runs on three surfaces — a GitHub Action, a command line, and an
 * agent asked to look at work in progress — and only the first of those has a
 * pull request. Rather than fork the pipeline, this presents a git range in the
 * same shape the pipeline already consumes: changed files with patches, an
 * empty prior review, and posting operations that do nothing.
 *
 * The alternative was to copy the review sequence into a second entry point.
 * The context-budget calculation was written twice earlier in this project and
 * drifted far enough that a benchmark silently measured a configuration that no
 * longer shipped, so the sequence stays in one place and the *source* varies.
 */
export class LocalSource {
  constructor(
    private root: string,
    private base: string,
    private head?: string,
  ) {}

  private git(...args: string[]): string {
    return execFileSync('git', ['-C', this.root, ...args], {
      encoding: 'utf8',
      maxBuffer: 1e9,
    });
  }

  /** The range being reviewed, printed for the reader so it is never ambiguous. */
  describe(): string {
    return this.head ? `${this.base}...${this.head}` : `${this.base}...working tree`;
  }

  /**
   * Changed files with their patches.
   *
   * With no `head`, the comparison includes uncommitted work — which is the
   * case an agent asks about most often ("review what I just wrote"), and the
   * one a pull request cannot express.
   */
  async loadPullRequest(_n: number, _incremental: boolean, _atSha?: string): Promise<PullRequestContext> {
    const range = this.head ? [`${this.base}...${this.head}`] : [this.base];
    const stat = this.git('diff', '--numstat', '--no-renames', ...range);

    const files: ChangedFile[] = [];
    for (const line of stat.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      const path = m[3]!;
      const patch = this.git('diff', '--unified=3', '--no-color', '--no-renames', ...range, '--', path);
      const at = patch.indexOf('\n@@');
      const body = at >= 0 ? patch.slice(at + 1) : '';
      files.push({
        path,
        status: 'modified',
        additions: m[1] === '-' ? 0 : Number(m[1]),
        deletions: m[2] === '-' ? 0 : Number(m[2]),
        patch: body,
        addedLines: body ? addedLineNumbers(body) : [],
      });
    }

    let headSha = 'working-tree';
    try { headSha = this.git('rev-parse', 'HEAD').trim(); } catch { /* no commits yet */ }

    // The branch name is the only statement of intent available locally. It is
    // usually a poor one, but the verifier judges scope against it and a bad
    // guess is better than telling it the change has no purpose at all.
    let title = 'Local changes';
    try { title = this.git('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* detached */ }

    return {
      number: 0,
      title,
      body: '',
      files,
      headSha,
      baseSha: this.base,
      isIncremental: false,
      author: 'local',
    } as unknown as PullRequestContext;
  }

  /** Nothing has been posted, so nothing has been said before. */
  async loadExistingReview(): Promise<ExistingReview> {
    return {
      fingerprints: new Set<string>(),
      postedFingerprints: new Set<string>(),
      lastReviewedSha: undefined,
      walkthroughId: undefined,
    } as unknown as ExistingReview;
  }

  /** Everything is "unanchored" locally: there is no diff view to attach to. */
  planComments(findings: Finding[]): ReviewPlan {
    return { anchored: [], unanchored: findings } as unknown as ReviewPlan;
  }

  async currentHeadSha(): Promise<string | null> { return null; }
  async submitReview(): Promise<{ posted: number; degraded: boolean }> {
    return { posted: 0, degraded: false };
  }
  async upsertWalkthrough(): Promise<void> { /* nothing to post to */ }
  async resolveThreads(): Promise<number> { return 0; }
  /** Nothing was ever submitted locally, so nothing can be stale. */
  async dismissStaleReviews(): Promise<number> { return 0; }

  /**
   * No API client, which is what disables cross-review recall.
   *
   * Local reviews have no pull-request history to read corrections back from.
   * That costs memory of other reviews, not correctness of this one.
   */
  readonly raw = undefined;
}
