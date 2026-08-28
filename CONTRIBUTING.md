# Contributing

## Getting it running

```bash
npm ci
npm run typecheck
npm run build
```

Node 22 or later. There is no test suite yet — see below, it is the most useful
thing you could add.

Review your own changes with the tool:

```bash
npm run dev -- --base main
```

## What this project is trying to be

A reviewer whose findings are worth reading. The measure is not how many it
posts but what fraction survive a maintainer checking them, so a change that
raises recall while raising the false positive rate is usually a bad trade.

Two properties are load-bearing and a change that breaks either needs to argue
for itself:

**No central service.** The tool runs on your runner, against your model
endpoint, under your own bot identity. There is deliberately nothing to sign up
for, and nothing about a review passes through infrastructure the authors
control. Features that would require one are the wrong shape for this project.

**Findings are verified before they are posted.** Every candidate is checked
against the code and against the change's stated purpose, and most do not
survive. That filter is the product.

## Changing prompts or ranking

These are the easiest things to change and the hardest to change *well*: prompt
edits look obviously right and frequently make results worse in ways only
measurement catches.

If you change `src/review/prompt.ts`, the pass structure in `src/review/run.ts`,
or anything about retrieval, say in the pull request what you ran it against and
what happened. "Reviewed 5 pull requests, 2 findings I judged false before, 0
after, no findings lost" is a real argument. "Clearer wording" is not, because
several such changes have measurably regressed this.

Beware small samples. The find pass samples at varying temperature, so a
2-case comparison has a run-to-run swing about as large as any effect you are
trying to measure.

## Style

Match the file you are editing. A few conventions that are deliberate:

- **Comments explain why, not what.** Most non-obvious code here carries the
  reason it is shaped that way, usually a specific failure it exists to prevent.
  If you remove such a comment, the next person reintroduces the bug.
- **Failures degrade rather than throw.** A missing store, an unavailable
  learning, a thread that cannot be resolved — none of these should cost a
  review that already took minutes of model time.
- No new runtime dependencies without a reason. The Action ships as a bundle and
  native modules do not survive that.

## Especially welcome

- **A test suite.** There is none, only ad-hoc probes that were not committed.
- **Languages beyond TypeScript and JavaScript.** The symbol graph in
  `src/graph/` is a hand-written parser; other languages need equivalents.
- **False positives.** If the tool posted something wrong on your code, an issue
  with the finding and the code that disproves it is directly actionable — that
  is the failure mode this project cares most about.

## Pull requests

Open an issue first for anything large, so you do not build something that gets
turned down on direction. Keep commits readable; there is no squash policy.

CI runs typecheck and build on every pull request, with no secrets available and
a read-only token, so a fork PR cannot reach anything.
