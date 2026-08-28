# Running it

reviewpass runs three ways. They share one pipeline, so a finding you see at the
terminal is the finding that would be posted on a pull request.

Pick by where the changes are:

| The changes are | Use |
|---|---|
| on a pull request | [the Action](#on-a-pull-request-github-action) |
| on your machine, maybe uncommitted | [the CLI](#on-your-machine-cli) |
| whatever an agent is looking at | [the skill](#inside-a-coding-agent-skill) |

---

## On your machine (CLI)

Install it, or don't:

```bash
npm i -g @magicpages/reviewpass     # or: npx @magicpages/reviewpass
```

Point it at a base ref. Everything since that ref, including work you have not
committed, gets reviewed:

```bash
reviewpass --base main
```

You need a model endpoint. Any OpenAI-compatible one works — a hosted broker, a
vendor API, or a llama.cpp server on your own machine:

```bash
export REVIEWPASS_API_KEY=sk-...
export REVIEWPASS_ENDPOINT=https://openrouter.ai/api/v1
```

No GitHub token, no network access to GitHub, and nothing is posted anywhere.

Other ranges:

```bash
reviewpass --base HEAD              # just what I have not committed
reviewpass --base main --head HEAD~3
reviewpass --base main --workspace ../other-repo
```

Expect three to five minutes for a handful of files. Most of that is the model
reading; the code graph over a 2,000-file repository takes about two seconds.

### Reviewing a pull request from the terminal

```bash
reviewpass --repo acme/api --pr 412
```

This reads the pull request from GitHub and prints the review. It does not post.
Adding `--post` submits it, which is the only thing that writes anywhere.

Credentials come from `GITHUB_TOKEN`, or from `gh auth token` if that is unset.

---

## On a pull request (GitHub Action)

```yaml
name: review
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: magicpages/reviewpass@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          REVIEWPASS_API_KEY: ${{ secrets.REVIEWPASS_API_KEY }}
          REVIEWPASS_ENDPOINT: https://openrouter.ai/api/v1
```

`actions/checkout` is required here, unlike in the daemon setup below — the code
graph is built from the files in the workspace. A shallow checkout is fine.

`pull-requests: write` is the only write permission needed. There is no database
to persist and no branch to push, so `contents: read` is enough for the rest.

### Sending your code somewhere

Reviewing means sending your source to whichever provider serves the request. On
a broker, constrain that:

```yaml
        env:
          REVIEWPASS_ZDR: '1'      # zero-data-retention providers only
```

Or set `model.provider` in `.reviewpass.yaml` for finer control — an explicit
provider order, exclusions, whatever your broker accepts. reviewpass passes that
block through without interpreting it.

### Handing the work to a daemon

If your runners sit on the same machine as your models, `daemon-url` posts the
job to a long-running process instead of doing the work in the job. That process
keeps a bare mirror of the repository and a SQLite store, so it starts faster and
remembers more. `deploy/install.sh` sets it up.

Most people do not need this. The in-job path has no such requirements.

---

## Inside a coding agent (skill)

Copy the skill into your agent's skills directory:

```bash
mkdir -p .claude/skills/reviewpass
cp node_modules/@magicpages/reviewpass/skill/SKILL.md .claude/skills/reviewpass/
```

Then ask for a review in whatever words you like — "review my changes", "check
this branch before I open a PR". The skill tells the agent which command matches
which request, and how to present what comes back.

The skill exists to stop two failure modes. An agent asked to review code will
otherwise read the diff itself and report whatever it notices, which is the
unverified opinion reviewpass exists to replace. And an agent holding a list of
findings tends to start fixing them, which removes your chance to disagree
first. The skill says: run the command, show the findings, stop.

If reviewpass is not installed, the agent falls back to reviewing by hand and is
told to label the result as unverified.

Agents that read `.claude/skills` include Claude Code. Others use different
directories for the same file — `SKILL.md` is plain markdown with YAML
frontmatter, so it ports without changes.

### Talking to an agent about the output

The skill runs with `--json`, and you can too:

```bash
reviewpass --base main --json
```

```json
{
  "range": "main...working tree",
  "verdict": "COMMENT",
  "candidates": 19,
  "findings": [
    {
      "path": "src/webhook.ts",
      "startLine": 41,
      "endLine": 43,
      "severity": "major",
      "category": "security",
      "importance": 7,
      "title": "Verify the signature before reading the body",
      "body": "The handler parses the payload at line 41 and checks the HMAC at line 58...",
      "suggestion": "…",
      "siblings": []
    }
  ],
  "refuted": [
    { "path": "src/webhook.ts", "title": "…", "reason": "incorrect: …" }
  ],
  "usage": { "promptTokens": 63963, "completionTokens": 29948 },
  "seconds": 302.3
}
```

`candidates` counts what was raised before verification; `findings` is what
survived it. The gap between them is the filter working. `refuted` is worth
skimming when a finding you expected is missing.

---

## What differs between them

| | CLI (`--base`) | CLI (`--pr`) | Action | Skill |
|---|---|---|---|---|
| needs a GitHub token | no | yes | yes | only for `--pr` |
| reviews uncommitted work | yes | no | no | yes |
| can post comments | no | with `--post` | yes | no |
| remembers past reviews | no | yes | yes | only for `--pr` |
| code graph | yes | yes | yes | yes |
| static analysis | yes | yes | yes | yes |

"Remembers past reviews" means reading maintainer replies from earlier pull
requests, so a finding you argued down once is not raised again. That needs the
GitHub API, so a local review starts cold. It reviews the same way; it just
knows less about what you have already rejected.

## When something goes wrong

**"No model endpoint"** — set `REVIEWPASS_API_KEY` and `REVIEWPASS_ENDPOINT`, or
put them in `.reviewpass.yaml`.

**Static analysis reports nothing on a repository that has type errors** — the
log distinguishes `Static analysis ran clean` from `static analysis skipped`. The
skipped case means no `node_modules` was found and none could be linked from a
parent checkout.

**Reviews take too long on a large pull request** — time scales with the number
of candidates, not files. Lower `review.findSamples` from 4 to 2; you lose the
cross-file and absence passes, which is most of what finds missing code.

**A finding was posted that is plainly wrong** — reply to it saying why. That
reply is read back on later reviews and the finding is not raised again. This is
the intended way to correct it; there is no separate configuration for
suppressing a rule.
