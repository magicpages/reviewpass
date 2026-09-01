import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Cross-pull-request memory, rebuilt from the pull requests themselves.
 *
 * A reviewer wants to remember two things across pull requests: findings a
 * maintainer rejected, so it stops repeating them, and the reasons they gave,
 * so it applies them elsewhere. Both were already written down — in the reply
 * under the finding — so the durable copy everything else reaches for is a
 * second copy of data GitHub is already holding.
 *
 * Every place to keep that second copy is worse than not keeping it:
 *
 *   - an Actions cache is scoped per git ref, so pull-request runs never share
 *     one, and its contents are readable by anyone who can open a fork PR;
 *   - a state branch needs `contents: write` on a reviewer that otherwise only
 *     comments, and two pull requests finishing at once race to push it;
 *   - an issue used as a store caps at 65,536 characters and breaks when
 *     somebody tidies it away;
 *   - a committed database is all of the above plus merge conflicts.
 *
 * Reading it back instead costs, measured against a repository of ~1,600 pull
 * requests: 11 GraphQL points of an hourly 5,000, and 1.4 seconds. Against a
 * review that spends minutes and hundreds of thousands of model tokens, that is
 * not a cost worth engineering around — and it needs no permission the reviewer
 * does not already hold, cannot go stale, cannot be evicted, and cannot be
 * corrupted by someone editing the wrong thing.
 *
 * Persistence remains available for installations that want to skip even this;
 * it is an optimisation, and a cold start is less informed rather than wrong.
 */

export interface DerivedMemory {
  /** Fingerprints a maintainer argued down. Never raise these again. */
  rejected: Set<string>;
  /** What they said instead, as learnings scoped to the repository. */
  learnings: { content: string; sourcePr: number; path?: string }[];
}

const FINDING_RE = /<!-- (?:reviewpass|warren):finding:([a-f0-9]+) -->/;

/** Replies that accept rather than correct. Nothing to learn from agreement. */
const ACCEPTANCE = /^\s*(fixed|done|good catch|thanks|addressed|resolved|applied|will do|agreed)\b/i;
// Politely agreeing that nothing needed changing is not acceptance, and reading
// it as acceptance is worse than reading it as nothing. "Agreed - no defect,
// nothing to change" was answered four times on one pull request, to four
// comments that had announced the code was fine; because the reply opened with
// "agreed" every one of them was filed as a confirmed finding and none was
// recorded as rejected. The reviewer was being taught that its own withdrawn
// hypotheses land well.
const DECLINED = /\b(no change|no defect|no action|nothing to change|not fixing|already (fixed|covered|present|handled)|no bug)\b/i;
const confirms = (body: string) => ACCEPTANCE.test(body) && !DECLINED.test(body.slice(0, 200));

export async function deriveMemory(
  kit: Octokit,
  owner: string,
  repo: string,
  opts: { pullRequests?: number; log?: (m: string) => void } = {},
): Promise<DerivedMemory> {
  const limit = opts.pullRequests ?? 50;
  const rejected = new Set<string>();
  const learnings: DerivedMemory['learnings'] = [];

  try {
    const data = await kit.graphql<{
      repository: {
        pullRequests: {
          nodes: {
            number: number;
            reviewThreads: {
              nodes: {
                path: string | null;
                comments: { nodes: { author: { login: string } | null; body: string }[] };
              }[];
            };
          }[];
        };
      };
    }>(
      `query($owner:String!,$name:String!,$limit:Int!) {
         repository(owner:$owner,name:$name) {
           pullRequests(last:$limit, states:[MERGED,CLOSED,OPEN]) {
             nodes {
               number
               reviewThreads(first:30) {
                 nodes {
                   path
                   comments(first:4) { nodes { author { login } body } }
                 }
               }
             }
           }
         }
       }`,
      { owner, name: repo, limit },
    );

    for (const pr of data.repository.pullRequests.nodes) {
      for (const thread of pr.reviewThreads.nodes) {
        const comments = thread.comments.nodes;
        const root = comments[0];
        if (!root) continue;

        // Only our own threads carry a fingerprint, and only those can be
        // matched against a finding raised later.
        const fingerprint = FINDING_RE.exec(root.body)?.[1];
        if (!fingerprint) continue;

        const replies = comments.slice(1).filter((c: { body: string }) => c.body.trim());
        if (!replies.length) continue;

        // A reply that just says "fixed" confirms the finding; it is not a
        // correction and teaches nothing. A reply that argues is the signal.
        const corrections = replies.filter((r: { body: string }) => !confirms(r.body));
        if (!corrections.length) continue;

        rejected.add(fingerprint);
        for (const c of corrections) {
          const content = c.body.replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 600);
          if (content.length > 20) {
            learnings.push({ content, sourcePr: pr.number, path: thread.path ?? undefined });
          }
        }
      }
    }

    opts.log?.(
      `Recalled ${learnings.length} correction(s) and ${rejected.size} rejected finding(s) ` +
      `from the last ${limit} pull requests`,
    );
  } catch (err) {
    // Memory is an optimisation. A rate limit or a permissions gap costs recall
    // of other pull requests, not the review of this one.
    opts.log?.(`could not recall earlier reviews (${String(err).slice(0, 100)})`);
  }

  return { rejected, learnings };
}
