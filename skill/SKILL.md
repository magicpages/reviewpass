---
name: reviewpass
description: >
  Review code changes for defects. Use when asked to review a diff, a branch, a
  pull request, or work in progress. Runs a multi-pass review that verifies each
  finding before reporting it — checking that the claim is true of the code and
  that it belongs on this change. Read-only and advisory: it never writes to the
  repository or to GitHub unless explicitly asked to post.
---

## Reviewing changes with reviewpass

`reviewpass` is a command. Run it, read its JSON, and present what it found.
Do not re-derive the review yourself — the point of the tool is that its
findings have already been checked against the code, and a second unverified
opinion layered on top undoes that.

### Which command

Work out what the user means by "these changes" before running anything.

| They mean | Command |
|---|---|
| what I have written but not committed | `reviewpass --base HEAD --json` |
| this branch, against main | `reviewpass --base main --json` |
| a specific range | `reviewpass --base <ref> --head <ref> --json` |
| pull request N | `reviewpass --repo <owner>/<name> --pr N --json` |

Add `--workspace <dir>` when the repository is not the current directory.

Local modes need no GitHub token and post nothing. The pull-request mode reads
from GitHub and still posts nothing — **only `--post` submits a review**, and
you must not pass it unless the user asked you to post.

If the command is not found, say so and offer:
`npx --yes @magicpages/reviewpass --base main --json`.

### What comes back

```json
{
  "range": "main...working tree",
  "verdict": "COMMENT",
  "candidates": 19,
  "findings": [
    { "path": "src/x.ts", "startLine": 41, "endLine": 43,
      "severity": "major", "category": "correctness", "importance": 7,
      "title": "…", "body": "…", "suggestion": "…", "siblings": [] }
  ],
  "refuted": [ { "path": "…", "title": "…", "reason": "incorrect: …" } ],
  "usage": { "promptTokens": 0, "completionTokens": 0 }
}
```

`findings` survived verification. `candidates` is how many were raised before
it — the gap between them is the tool working, not a loss.

`refuted` is worth reading yourself even though it is not worth showing the
user in full: if something there looks wrongly dismissed, that is worth one
sentence to them, because it is the failure mode this tool is least able to
detect on its own.

### Presenting the result

Lead with the count and the verdict, then the findings in the order given —
they are ranked, and the first is the one most worth their attention.

For each: the file and line, the title, and the reasoning in the tool's own
words. Do not rewrite the reasoning to sound more confident than it is. Where a
`suggestion` exists, show it as a diff.

Then stop. Do not:

- **apply the fixes**, unless the user asks. A review and a rewrite are
  different requests, and conflating them removes their chance to disagree.
- **add findings of your own** to the list. If you genuinely spot something the
  tool missed, say so separately and label it as yours, so the user knows which
  claims were verified and which were not.
- **soften or drop findings** because they seem pedantic. Small, obviously
  correct fixes are the ones teams actually make.

If `findings` is empty, say that plainly. It is a normal outcome on a small or
careful change, and padding it with observations defeats the purpose.

### When it takes a while

A review is several model calls per file and takes minutes on a large diff —
roughly three minutes for a handful of files. Tell the user what is running
before you start it rather than leaving them watching a blank terminal.

### If reviewpass is unavailable

Say that the verified review is unavailable and that what follows is your own
unverified reading. Then review the diff yourself in three passes — defects,
then interactions between files, then **what the code does not do** (a missing
validation, an unhandled case, an assertion never made, a scope never applied).
Absence is the failure a diff cannot show you, and it is the one an unaided
reading misses most often.

Whatever you report that way, label it clearly as unverified.
