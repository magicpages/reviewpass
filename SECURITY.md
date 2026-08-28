# Security

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/magicpages/reviewpass/security/advisories/new).
Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a week. If a fix is warranted we will agree a
disclosure date with you and credit you in the advisory unless you would rather
we did not.

## What this tool touches

Worth understanding before you install it, because two of these are unusual.

**Your source code leaves your infrastructure.** Reviewing means sending the
diff, the surrounding file, and retrieved neighbouring files to whichever
provider serves the model request. If that matters to you, set
`REVIEWPASS_ZDR=1` to restrict routing to zero-data-retention providers, or
point `REVIEWPASS_ENDPOINT` at a model you host yourself — any OpenAI-compatible
endpoint works, including a local one.

**A GitHub App private key is long-lived.** The default path uses `GITHUB_TOKEN`,
which expires with the job and needs no secret. If you create an App so that
approvals count toward branch protection, its key does not expire: install it on
selected repositories rather than all of them, and store the key as a repository
or environment secret. `reviewpass init-app` writes the key with mode `600` and
adds it to `.gitignore`.

**The reviewer reads untrusted input.** A pull request's contents reach a model
whose output is posted as a comment. A crafted diff can therefore influence what
the reviewer says. The blast radius is bounded by what the tool is able to do at
all: it posts review comments and submits reviews, and nothing else. It does not
execute repository code, write to branches, or run anything a finding suggests.

## Fork pull requests

Do not use `pull_request_target` with this tool. Static analysis invokes the
repository's own TypeScript toolchain, and a `tsconfig.json` can load a plugin —
so a fork's configuration would execute inside a job holding your secrets. This
is the "pwn request" pattern and it is [documented by GitHub's own security
team](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/).

Reviewing forks safely needs the two-workflow `workflow_run` split, where the
unprivileged workflow handles the fork's code and the privileged one treats what
it produces as data and never executes it.

## Supported versions

The latest minor release. This is pre-1.0; expect fixes forward rather than
backports.
