# Benchmark

Measures how well a way of reviewing finds real defects in real pull requests:
reviewpass's pipeline against the same model given the diff and nothing else, and
any number of models and settings side by side.

The harness is in this directory. Your cases, checkouts, runs and results are not:
they go wherever your config points, and the default location, `eval/`, is
ignored by git. Keep them there. A reference built from a private repository
quotes its code and its review history.

## Method

1. **Frozen cases.** Each pull request is checked out at a fixed head commit, with
   no dependencies installed, as a production review sees it.
2. **Several runs per method.** Every method reviews every case `runs` times (3 is
   the minimum that says anything about consistency).
3. **A raw baseline.** For each model, a `raw` method sends the task, the diff and
   the changed files in one call, with no sampling, retrieval or verification. What
   the pipeline adds is measured against it.
4. **A reference from the union.** Every finding any run raised, including those
   reviewpass's verifier refuted, plus what the pull request's history already
   settled (optional), is grouped by cause: findings that name the same thing
   going wrong for the same reason.
5. **Blind judging.** Two judges rule independently on each cause, defect or not
   and how severe. A third settles the causes they disagree on. Judges see opaque
   labels only, never which method, run or model produced a finding.
6. **Blind assignment.** The second judge places every finding under a cause
   without seeing the first grouping, and the third settles disagreements.
7. **A hit names the mechanism.** A run scores one hit per reference defect it
   has at least one finding under. Location alone does not count, and three
   findings on one defect are one hit.

Choose judges from model families that none of the methods under test use, so no
model grades its own lineage.

The reference is a **lower bound**. A defect that no run and no reviewer ever
raised is not in it, so recall is recall against what anyone found.

## Requirements

- Node 22+, as `engines` in `package.json` requires, and `npm ci` in this repository.
- The GitHub CLI (`gh`), authenticated for the repository under test. Setup reads
  each pull request's title, body and base from it.
- A local clone of the repository under test.
- One or more OpenAI-compatible endpoints for the methods under test, and one for
  the judges. They can be the same service.

## Run it

```sh
mkdir -p eval/bench
cp benchmark/examples/spec.example.json eval/bench/spec.json
cp benchmark/examples/run-config.example.json eval/bench/run-config.json
# edit both, then:

npm run benchmark:setup -- eval/bench/spec.json      # clone, check out, write cases.json
export REVIEW_API_KEY=...  JUDGE_API_KEY=...         # the variables your config names
npm run benchmark -- eval/bench/run-config.json      # runs, reference, report
```

`benchmark` takes an optional stage after the config: `runs`, `reference`,
`report`, `filters` or `calibrate` (default `all`, which runs every stage but
`calibrate`). `filters` re-scores the runs of every
method that records `meta` as if it had dropped findings by a rule before
posting (agreement between samples, severity, category, importance,
confidence), and writes `filters.md`: the real defects each rule costs against
the noise it removes. It reads the runs and the reference only, so it costs
nothing to run. `calibrate` measures another panel of judges against the one the reference was
built with, before that panel is trusted to extend it: it re-rules every cause,
re-places the findings of the config's methods, and writes `calibration.md` with
how often the panels agree and every method's score under each panel's rulings.
Use it when the judges you can afford come from a family under test. Every
stage skips work already done, so an interrupted
benchmark resumes where it stopped:

- A finished run is not repeated. A failed or degraded run is.
- A method added after the reference was built does not rebuild it. Its findings
  are placed blind by both judges under the causes already judged, with the
  tiebreak settling differences; only findings neither can place become new
  causes and are ruled on.
- Every accepted judge reply is cached under a hash of the model, the prompts and
  the schema. A rerun pays only for calls it has not made.

## Configuration

### `spec.json`: which pull requests

| key | meaning |
|---|---|
| `source` | Path to your clone of the repository under test. |
| `repo` | `owner/name` on GitHub, for `gh pr view`. |
| `clone` | Where setup puts its own `--shared` clone. It must have no `node_modules`: reviewpass borrows the dependencies of the checkout a worktree belongs to, and a benchmark on a developer's clone would run static analysis that production does not. |
| `worktrees` | Directory for one checkout per pull request. |
| `cases` | `[{ "pr": 123, "head": "<commit>" }]`. The commit freezes the case. |
| `history` | Optional. Findings the pull request's review already settled, as `[{ "pr", "path", "line", "commit", "title", "body", "label": "good" \| "bad", "reason" }]`. They join the pool as candidates, not as ground truth. See `examples/history.example.json`. |

Setup writes `cases.json` next to the spec.

### `run-config.json`: how to run and judge

| key | meaning |
|---|---|
| `cases` | Path to the `cases.json` setup wrote. |
| `out` | Output directory for runs, the reference and the report. |
| `runs` | Runs per method and case. |
| `parallel` | Runs in flight at once. Each is its own process. |
| `keyEnv` | Name of the environment variable holding the key for the methods' endpoint. Keys are never written into the config. |
| `env` | Optional environment for reviewed runs, for example `{ "REVIEWPASS_CONCURRENCY": "2" }` for an endpoint that rate-limits bursts. |
| `methods` | `[{ "kind": "reviewpass" \| "raw", "model": { "endpoint", "name", "effort"?, "maxTokens", "verifyName"?, "verifyEffort"?, "review"?, "label"? }, "cases"? }]`. `effort` is sent as `reasoning_effort`. `verifyName` verifies with a different model than the one that finds. `review` sets review settings over the case repository's, for example `{ "findSamples": 6 }`, and becomes part of the method's name. `label` tells apart two runs of otherwise identical settings. `cases` limits a method to some case ids. |
| `judges` | `first`, `second`, `tiebreak`: `{ "name", "endpoint", "model", "keyEnv", "price": { "input", "output" }, "maxTokens"?, "timeoutMs"?, "extra"? }`. `price` is per million tokens. `timeoutMs` is the deadline for one call, reply included (default ten minutes); a call that misses it is retried like a rate limit. `extra` is sent verbatim with every judge call, for example provider routing or `{ "reasoning": { "enabled": false } }`. |
| `spendCap` | Stop judging once this much has been spent in one invocation. Uses the cost the endpoint reports when it reports one, the price table otherwise. |
| `calibrate` | Optional. `{ "judges": { "first", "second", "tiebreak" } }`, the panel the `calibrate` stage measures, in the same shape as `judges`. A judge on a subscription endpoint takes `price: { "input": 0, "output": 0 }`; the stage reports the tokens it used. |

## Output

Under `out`:

- `runs/<case>__<method>__<n>.json` and `.log`: each run's findings, what
  verification refuted, wall time, tokens and errors, plus its log. A
  reviewpass finding carries `meta`: severity, category, importance, verify's
  confidence and reason, and which find samples raised it - for scoring filters
  afterwards. Judges never see it.
- `reference/<case>.json`: the causes, every judge's verdict, and where each
  finding was placed. Partial stages are kept as `<case>.causes.json` and
  `<case>.entries.json`.
- `judge-cache/`: accepted judge replies. `unusable/`: rejected ones, kept whole
  so a rejection can be diagnosed.
- `report.md` and `scores.json`.

The report shows, per method and case: hits per run, false findings per run (a
finding placed under a cause the judges ruled not a defect), the union over runs,
files the model failed on, minutes, and generated tokens. It also shows how many
runs found each defect, by severity; what the verifier removed (real defects
against noise); and how often the judges needed the tiebreak.

## What to know before you spend money

- **Judging costs more than the runs.** Every judge call carries the file's diff
  and full text, so cost scales with changed-file size times findings. Judges
  that reason at length also bill that reasoning as output. Set `spendCap`, and
  judge one small case first to calibrate.
- **Give reasoning judges room.** If a judge's replies end at the length limit,
  raise its `maxTokens`. If its reasoning ignores a cap, disable reasoning for
  the tiebreak through `extra`: it settles two written rulings, not the whole file.
- **Rate limits are waited out, not scored.** A 429, a 5xx, or a provider error
  inside a 200 reply is retried on its own budget. A file the endpoint lost marks
  the run degraded, and the next invocation reruns it. A file the model itself
  failed on is the method's result and is reported, not retried.
- **Small differences are noise.** With three runs, a gap of one or two hits
  between methods can come from sampling alone. Measure the run-to-run spread
  before you read a winner.
- **Your code goes to the judges.** Pick endpoints whose retention terms you
  accept for that code. `extra` is where routing constraints go.
