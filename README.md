# reviewpass

A pull-request reviewer for JavaScript and TypeScript repositories. It posts
inline comments, ships committable suggestions, and approves or requests changes.

It runs against any OpenAI-compatible endpoint — a hosted broker, a vendor API,
or your own llama.cpp or vLLM server — as a GitHub Action, a local CLI, or a
long-lived daemon beside self-hosted runners.

What distinguishes it is what it refuses to say. A finding is posted only if it
is **true of the code** and **belongs on this change**; findings that cite files
which do not exist, or that report the same defect twice in different words, are
dropped before a person ever sees them.

## When a daemon is worth it

Only when your runners sit on the same machine as your models. Then a
self-contained Action wastes what that proximity buys: it would throw away state after every run, re-clone the
repository each time, and cross the network to reach a GPU sitting in the next
process.

`reviewpassd` keeps what a reviewer needs to be good:

| | Action-only | reviewpassd |
|:---|:---|:---|
| **Memory** | a JSON file restored from an Actions cache key | a real SQLite database of learnings, rejections and every finding ever posted |
| **Cross-repo knowledge** | none | learnings scoped `owner/*` apply across the organisation |
| **Repository access** | `actions/checkout` per run, usually shallow | a persistent bare mirror; a worktree materialises in ~80 ms with full history |
| **Model** | HTTP across the network | localhost, already warm |
| **Deduplication** | only what is visible in PR comments | the whole finding history, so a claim is not repeated across PRs |
| **Tooling** | whatever the runner image has | ripgrep, git, linters installed once |

The Action still exists — it is now a thin client that posts a job and prints the
result. Set no `daemon-url` and it runs the pipeline in-job instead, which works
on hosted runners at the cost of all of the above.

## How a review works

| Stage | What happens |
|:---|:---|
| **Select** | Every semantically meaningful changed file. Only lockfiles, snapshots, binaries, generated and minified content are dropped — triage is a false economy, and the file you skip is the one with the defect. |
| **Context** | Per file: the real source around every hunk, its test counterpart, the local modules it imports, other callers of the symbols it introduces, and how the rest of the repository uses the same APIs. Capped proportionally to the size of the change. |
| **Rules** | Mine `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `CONTRIBUTING.md`, repo-wide and per-directory. A finding that names the rule it rests on is one the reader can check rather than trust. |
| **Tools** | Run the repository's own ESLint and `tsc`, and pass the output in as *already reported*. A green type checker also lets the verifier refute findings that claim a type error. |
| **Find** | Four passes per file, unioned: two general, one across files, and one asking only what the code does **not** do. Absence is the failure a diff cannot show you. |
| **Reduce** | Collapse duplicates — including two descriptions of one defect that share no wording — and drop findings citing files the repository does not contain. |
| **Verify** | Findings anchored to the same code are judged together, so two of them cannot receive contradicting verdicts. Each must be true and in scope; importance is rated for ranking, never used to refuse a real defect. |
| **Post** | Inline comments with severity and category, a committable suggestion where one applies, and a block a coding agent can act on. |
| **Learn** | Maintainer replies become learnings; rejected findings are never raised again. |

### What it looks for

A checklist of recurring defect shapes — silent success on a failed or empty
write, non-atomic read-then-write, wrong API shape, trusting client-supplied
identity, missing normalisation before a comparison, distinct failures collapsed
into one, stale async results mutating state, contract drift between layers,
incomplete handling of sensitive data, a test that cannot fail — presented to the
model as *examples rather than a taxonomy*, because most real findings match none
of them and a reviewer that only pattern-matches finds only the patterns.

The harder half is absence: a validation not performed, a case not handled, a
scope not applied. A diff shows what was written and cannot show what was left
out, so one pass asks only that question, and retrieval supplies the established
form from elsewhere in the repository to compare against.

### Calibration

Defaults were tuned against one repository's review history and are defaults, not
claims. Two worth knowing about:

- **Brevity.** Human reviewers are terse; most of their comments are under 200
  characters. The prompt asks for that length rather than an essay.
- **Blocking is social.** Human reviewers request changes on a small minority of
  reviews, so `requestChangesAt` defaults to `critical`. A reviewer that blocks
  on every major finding is more obstructive than a colleague, and gets muted.

## Running it

Three ways, one pipeline — as a GitHub Action on a pull request, as a CLI over a
local git range, or as a skill inside a coding agent. **[docs/running-it.md](docs/running-it.md)**
has the commands, the workflow file, and what differs between them.

The short version:

```bash
npx @magicpages/reviewpass --base main        # local changes, nothing posted
npx @magicpages/reviewpass --repo o/n --pr 42 # a pull request, still nothing posted
```

Configuration is `.reviewpass.yaml` at the repository root; every key is
optional and annotated in [`.reviewpass.example.yaml`](.reviewpass.example.yaml).

## Talking to it

| Comment | Effect |
|:---|:---|
| `@reviewpass review` | review the commits added since the last run |
| `@reviewpass full review` | re-review the whole pull request |
| `@reviewpass resolve` | resolve its open threads |
| `@reviewpass ignore` / `resume` | stop or restart reviewing this pull request |

Replying to a finding is how it learns. Say why it is wrong and that finding is
not raised again; those replies are read back from the pull requests themselves
on later runs, so there is nothing to store and nothing to configure.

## Measured accuracy

The benchmark replays a pull request at the exact commit it was reviewed at and
matches findings semantically against the defects that team actually
implemented — 32 pull requests, 52 confirmed defects. `--at <sha>` exists for
this.

**Find pass** — does it raise the defect at all:

| Configuration | Recall |
|:---|:---:|
| two identical samples | 46 / 52 |
| context capped proportionally to the diff | 50 / 52 |
| four passes: two general, cross-file, absence | **≈ 91%**, held-out ≈ 94% |

Held-out means cases the prompts were never tuned against, which is the number
worth believing.

**Verify pass** — of what it raises, how much is worth showing. Measured against
60 candidates labelled independently, roughly a fifth of raw candidates deserve
an author's attention; verification lifts that materially while keeping most of
the real defects. It is the weaker half and the honest limit of the system.

**End to end**, verification costs recall: a find pass at ~90% lands nearer 70%
after everything that cannot be verified is dropped. That trade is deliberate —
a reviewer that is right about twenty trivia and one real bug is worse than one
that reports only the bug.

Two caveats worth stating plainly. The benchmark runs with an **empty learnings
store**, which is its worst case. And "the team implemented it" measures
*actionability*, not importance: small, obviously-correct fixes get made while
deep concerns get argued about, so optimising for that metric alone would
optimise for triviality.

**Judged by a human, on real work**, which is the number that matters most and
the least flattering one here. A maintainer triaged every finding from one
22-file pull request against the code: 13 were accepted and fixed, 8 were false
positives, 4 were correct but downgraded as out of scope. Two causes accounted
for nearly all of the loss — the reviewer had not been given code that settled
the question, and it asked for changes that conflicted with conventions the
repository already followed. Both are fixed, and neither was visible to the
benchmark above, which scores the find pass only and is structurally blind to
verification failures.

Treat this as a working system with an honest measurement, not as finished
accuracy. If it posts something wrong on your code, that is the bug report this
project most wants.

## What it costs

Time scales with the number of *candidates*, not files, because verification
dominates. Two measurements on a hosted endpoint:

| Change | Time | Findings |
|:---|:---|:---|
| 5 files | ~4 min | — |
| 24 files, 481 candidates | ~34 min | 52 posted |

Concurrency is derived from the endpoint: 6 in-flight calls against a hosted
provider, 2 against a local server, since a local `llama.cpp` typically serves
one or two slots and more requests than slots simply queue. Override with
`REVIEWPASS_JOBS`, and raise the server's `--parallel` to match if you do.

If a large pull request is too slow for your CI, lower `review.findSamples`
from 4 to 2. You lose the cross-file and absence passes, which are most of what
finds *missing* code, so it is a real trade rather than a free saving.

Running against your own hardware is cheaper per token than a hosted provider
but slower per review, and the crossover depends entirely on your electricity
price and how idle the machine otherwise is.

## Layout

```
src/
  config/     .reviewpass.yaml loading and defaults
  model/      OpenAI-compatible client: retries, json_schema, thinking models
  github/     PR loading, comment anchoring, review submission, chat commands
  context/    file selection, instruction mining, retrieval, linters, search
  review/     prompts, schemas, find/verify/decide, comment rendering
  store/      SQLite: learnings, rejections, finding and run history
  git/        bare mirrors and ephemeral worktrees
  server/     the daemon and its HTTP API
  pipeline.ts the whole flow, shared by the daemon, the Action and the CLI
examples/     a workflow to copy into the repository you want reviewed
skill/        SKILL.md, for agents that read a skills directory
deploy/       systemd unit and installer for the optional daemon
```

## Known limits

- **Inline anchoring.** GitHub rejects an entire review if one comment points
  outside the diff, so unanchorable findings move into the summary rather than
  being dropped. Anything more than 10 lines from a changed line counts as
  unanchorable.
- **Search backend.** ripgrep when present, then `grep`, then a bounded Node
  walker capped at 6,000 files.
- **No cross-file synthesis pass yet.** reviewpass reports sibling sites when the
  model names them, but does not run a dedicated pass over the whole change set
  rather than repeating it per location. That was a small share of
  findings, so it is a refinement rather than a gap.
- **Mirrors grow.** One bare mirror per repository under `REVIEWPASS_MIRRORS`; prune
  repositories you no longer review.
