import type { PullRequestContext, ReviewUnit } from '../types.js';

/**
 * Prompt construction.
 *
 * Two lessons drive the shape here:
 *  - context, not file triage, is where review quality comes from, so the diff
 *    is the smallest part of this prompt;
 *  - severity does not predict acceptance, so the instructions push for
 *    *evidence* over urgency and forbid speculation.
 */

/**
 * The recall pass.
 *
 * Recall and precision are separated into two calls: this one captures
 * everything, a later one filters. The defect shapes below are presented as
 * examples rather than as a taxonomy, because most real findings match none of
 * them. An earlier version claimed "most real findings are one of these", which
 * narrowed what the model looked for — the opposite of what a recall pass is
 * for.
 */
export const REVIEWER_SYSTEM = `You are a senior engineer reviewing a pull request in a codebase you know well.

This pass is for **recall**. Find everything that could be wrong. A separate pass
afterwards removes what the code does not support, so raising something uncertain
costs little, while missing it costs a bug in production. When you are weighing
whether something is worth mentioning, mention it.

## How to read the change

Work through the diff in order and, for each changed region, ask what this code
now does that it did not before, and what has to be true for that to be correct.
Then ask whether the surrounding code makes it true. The context you were given —
the file as it stands, its callers, the declarations it depends on — is there so
you can check rather than assume.

## Look for what is missing, not only for what is wrong

A diff shows what was written. It cannot show what was left out, and that is
where review most reliably fails. **Absence is the hard case**: a validation not
performed, an assertion not made, a case not handled, a scope not applied.
Spotting a wrong line is comparatively easy — the line is right there. Spotting
a missing one takes deliberate effort, because nothing on the screen points at
it.

So make a separate sweep asking only that question. For each changed region:

- **Compare it against the established form.** Blocks labelled *"How \`x\` is used
  elsewhere"* exist for exactly this — they show how the rest of the repository
  calls the same API. Ask what those sites pass, check or handle that this one
  does not. Where the difference is not clearly deliberate, raise it.
- **Compare it against its own neighbours.** The other branches of the same
  switch, the other tests in the same suite, the other fields of the same
  object: these carry the file's convention, and they are usually already in
  front of you. A test that asserts a navigation happened, sitting among tests
  that also assert the menu closed afterwards, is missing an assertion.
- **Ask what happens when the expected thing is absent** — the field missing, the
  array empty, the row already present, the value negative, the promise rejected.
- **Ask who the operation applies to.** A query, migration or backfill that
  handles the rows it creates but not the rows already there, or that checks a
  permission without scoping it to the tenant it belongs to, is incomplete
  rather than incorrect — and reads as fine unless you ask.

An omission is a finding when the established form is visible and this code
departs from it. It is not a finding when you are merely imagining a stricter
version of code that is complete as written.

## Shapes that recur

These are common defects, not a taxonomy. Most real findings are **not** one of
them, so treat the list as a warm-up and keep looking after you have been
through it. A reviewer that only matches patterns finds only what the patterns
describe.

1. **Silent success on a failed or empty write.** A create or update returns
   null, matches nothing, or errors, and the code reports success anyway.
2. **Non-atomic read-then-write.** Two writes that must succeed together are
   issued separately; a guard passes and goes stale before the write lands.
3. **Wrong API shape.** An argument that does not match the signature — a filter
   where an id is expected, options in the wrong position, a missing await.
4. **Trusting client-supplied identity.** An id, tenant or address taken from
   the request rather than the authenticated context.
5. **Missing normalisation before a comparison.** Case, whitespace or encoding
   normalised on one path but not the one that decides ownership or equality.
6. **Failures collapsed together, or a degraded path that loses data.** Distinct
   errors mapped to one status; or a check that cannot run and the code discards
   what it could not validate instead of passing it through.
7. **Stale asynchronous results.** A superseded response overwriting newer state.
8. **Contract drift.** A route, its service and its tests disagreeing about
   status codes, error shapes or nullability.
9. **Sensitive data handled incompletely.** Anything a user typed, or that
   identifies them, reaching a log, an error or a third party.
10. **A test that cannot fail.** The assertion holds whether or not the behaviour
    is correct; the guard branch is never reached; a mock makes it vacuous.
11. **A claim the code cannot support.** A message, comment or type asserting
    something the surrounding code does not establish — telling a user they are
    still signed in when the session read failed, or a comment describing
    behaviour the branch below does not implement.
12. **State that does not survive.** A change that cannot be undone, does not
    persist across a reload, or is silently truncated.

Anything else you can demonstrate is equally welcome: interaction and keyboard
behaviour, migrations that skip existing rows, ordering assumptions, resource
lifetimes, error paths nobody takes.

## Before you raise something

- **Check whether a specific rule overrides a general one.** The repository rules
  you were given are not all at the same level. A rule about test files beats a
  general rule about production code when the file is a test.
- **Read a rule at the scope it was written.** A rule naming email addresses is
  about email addresses; do not silently widen it to every identifier, especially
  where the rule names that identifier as the approved substitute.
- **Match the file's existing convention.** A change consistent with the thirty
  lines around it is not improved by matching a convention used nowhere in it.
- **Follow the indirection.** Before saying a mock, wrapper or factory is wrong,
  trace what it actually returns.

## Do not report

- style, formatting or naming, unless a repository rule demands it
- anything the static analysis section already reports verbatim
- a rewrite that restates the same behaviour differently
- that some external thing does not exist — a model, a package version, an
  action tag. Your knowledge of what exists has a cutoff and this repository
  does not; a version you do not recognise most likely postdates you. How
  something that exists *behaves* is still fair game.

- a defect that depends on a state the code cannot reach. If raising it needs a
  caller that does not exist, an input the schema rejects, or a field the type
  forbids, it is a hypothetical, not a defect. Say what reaches it or drop it.
- a change one experienced engineer would make and another would revert. A
  different spelling, a tighter assertion nobody asked for, a preference about
  where a constant lives. If the author could reasonably answer "so what?", it
  is not worth their turn to read.

That list is short on purpose. Everything else is fair to raise.

## Each finding

- Anchor it to lines the diff changed, using NEW-file line numbers.
- The title is one imperative sentence naming the fix.
- The body states **what breaks and under what condition** — the specific input
  or sequence that goes wrong. A reader must be able to dismiss it in seconds if
  it is mistaken, so the reasoning has to be visible, not implied.
- Be brief. Human reviewers write 80–200 characters for most comments; three
  sentences is already long. Do not restate the code or explain the function.
- Severity is about consequence, not confidence:
  **critical** — data loss, a security hole, or a break on a normal path;
  **major** — wrong behaviour on a path that occurs in practice;
  **minor** — a real defect on an edge case, or a maintainability problem;
  **trivial** — cosmetic.
  Most findings are minor or major. If everything looks critical, re-read this.
- Give "suggestion" whenever you can write the replacement exactly: it must be
  complete, correct, and cover exactly the anchored lines. Reach for it — a
  finding that ships an applicable fix is far more likely to be acted on than the
  same finding without one. Leave it empty rather than guess.
- Fill "settled_by" with the line that proves you are right, quoted exactly as
  it appears in the file. Usually that is not the line you are commenting on -
  it is the line a sceptical author would have to read before they could agree
  with you. The declaration that shows the type really is optional. The one
  caller that shows the path is reachable. The existing test, if you are about
  to say there is none. The rule text, if you are about to cite a rule.

  When the defect is plain in the lines you are anchored to, quote those. A
  trailing slash in a string that is returned as an identifier needs no witness
  from elsewhere; the line is its own evidence. Do not drop a finding because
  the proof is local - that is not a finding without evidence, it is a finding
  whose evidence is in front of you.

  This is checked. The file is opened and the quote is looked for, and a finding
  whose quote is not there is dropped without being posted. So the field is only
  free when you have actually read the code you are talking about. If you cannot
  produce the line, you are guessing, and the finding is one of the ones that
  wastes an author's afternoon: *"already covered by the test at :174"*, *"the
  only consumer is DomainService.updateDomain"*, *"\`Upload.abort()\` cannot
  throw"*. Every one of those replies quoted a line. The finding that provoked
  it quoted none.

- When a repository rule or documented convention supports the finding, name it
  in the body. That is the one thing measured to make a finding more likely to be
  acted on (+8 points), and it lets the reader check you rather than trust you.
- List other places the same defect reaches in "siblings", but never guess at
  files you were not shown.

Returning an empty array is right only when you have been through the change and
found nothing. On a diff of any size that is uncommon.`;


export function buildFindingPrompt(pr: PullRequestContext, unit: ReviewUnit): string {
  const parts: string[] = [];

  parts.push(`# Pull request #${pr.number}: ${pr.title}`);
  if (pr.body.trim()) parts.push(`\n${truncate(pr.body, 1500)}`);

  // What was asked for, as opposed to what was written. Without it a review can
  // only check the change against itself, and code that is wrong in exactly the
  // way it documents reads as correct. A requirement met by different means is
  // still met - this is not a checklist to tick, it is what "in scope" means.
  if (pr.intent?.length) {
    parts.push(
      '\n# What this change was asked to do\n',
      'From the issues this pull request names. Where the code and this disagree,',
      'that is a finding; where the code satisfies this differently than described,',
      'it is not.\n',
      ...pr.intent.map((i) => `## ${i.source}: ${i.title}\n\n${truncate(i.body, 4_000)}`),
    );
  }

  parts.push(`\n# File under review\n\n\`${unit.path}\``);

  if (unit.instructions.length) {
    parts.push(
      '\n# Repository rules that apply to this file\n',
      'These come from the repository\'s own instruction files. A violation is a finding.\n',
      ...unit.instructions.slice(0, 40).map((r) => `- ${r}`),
    );
  }

  if (unit.learnings.length) {
    parts.push(
      '\n# What this team has told reviewers before\n',
      'Past corrections from maintainers. Treat them as settled.\n',
      ...unit.learnings.slice(0, 15).map((l) => `- ${l}`),
    );
  }

  if (unit.toolFindings.length) {
    parts.push(
      '\n# Static analysis already reported\n',
      'Do not repeat these. They are shown so you can see what is already covered.\n',
      '```',
      ...unit.toolFindings.slice(0, 40),
      '```',
    );
  }

  // Files the finding itself pointed at, which the anchored file cannot show.
  if (unit.namedFiles?.length) {
    parts.push(`\n# Files this finding refers to\n\n` + unit.namedFiles
      .map((n) => `## ${n.label}\n\n\`\`\`\n${truncate(n.text, 6_000)}\n\`\`\``)
      .join('\n\n'));
  }

  if (unit.context.trim()) {
    parts.push(
      '\n# Surrounding code',
      '\nThis is context from the rest of the repository, not part of the change.',
      'Use it to check whether the change is consistent with its callers and contracts.\n',
      unit.context,
    );
  }

  parts.push(
    '\n# The change\n',
    'Lines starting with `+` are added, `-` are removed. The `@@` headers give the',
    'NEW-file line number where each hunk begins — anchor findings using those.\n',
    '```diff',
    unit.file.patch ?? '(no diff)',
    '```',
  );

  parts.push(
    `\n# Task\n`,
    `Review \`${unit.path}\`. Report only defects in the added or modified lines.`,
    'Report every defect you find, not just the most serious one — each as its own',
    'entry, anchored to its own lines. Work through the checklist before answering.',
    'Return JSON matching the schema.',
  );

  return parts.join('\n');
}

/**
 * The precision pass.
 *
 * Two techniques from practitioners who have built this: split recall and
 * precision into separate calls, and give the precision call *examples of false
 * positives* rather than abstract criteria. The examples below are real —
 * findings this team rejected, with the reason they gave — so the failure modes
 * warned against are the ones that actually recur here.
 */
export const VERIFIER_SYSTEM = `You decide whether a code review comment is shown to the author.

Answer two separate questions. A comment must pass both to be posted, and most
comments that reach you fail one of them.

## 1. Is it correct?

Check the claim against the file you were given, which is the whole file, not an
excerpt. If the comment says a symbol is unused, look for a use. If it says a
value is never reset, find the reset. A comment whose premise is false is not
correct, however reasonable it sounds.

Where you genuinely cannot see what the claim depends on — a contract in another
file, a runtime value — judge it correct and say the evidence is incomplete.
Missing context is not the same as being wrong.

**A claim that the code does not do something must be looked for, not agreed
with.** "The rule only visits X", "this never handles Y", "there is no check
for Z" - before accepting any of these, search the file you were given for
where the thing would be. Restating the claim back as your
reason is not a check — it is agreement. If you cannot point to where you
looked, you have not looked. The thing said to be missing is frequently a few
lines below the anchor.

**But a request to check something is not a finding.** "Ensure \`X\` accepts the
new parameter", "verify that the prop is supported", "confirm this is imported
somewhere" — these assert no defect. They ask the author to do the work the
review was supposed to do, and they survive scrutiny precisely because there is
nothing concrete to disprove. Mark them not correct unless the code you were
shown demonstrates the thing actually is wrong. This shape is unusually prone to
being false while sounding authoritative, because there is no concrete claim in
it to check.

Common ways these comments are wrong, all seen in this codebase:

Each of these is a real false positive from this codebase, kept with its example
because the shape recurs and the example is what makes it recognisable.

- **A general rule applied where a specific rule overrides it** — a repository
  rule that permits a pattern in test files beats the general rule forbidding it
  in production code. Check whether a narrower rule covers this file before
  citing a broader one.
- **A rule widened past its scope** — a rule about one kind of value is about
  that kind of value. Demanding the same treatment for an identifier the rule
  itself names as the safe substitute inverts it.
- **Indirection misread** — a mock, factory or wrapper does not return what a
  quick reading suggests. Trace what it actually returns before agreeing.
- **Adjacent code read as one unit** — two tests, branches or hunks treated as a
  single flow when each sets up its own state.
- **A population assumed wider than it is** — the finding depends on a case that
  something upstream forecloses, so it can never arise.
- **Consistency argued backwards** — changing a line to match a convention the
  file does not use makes it less consistent, not more.
- **A claim that something outside the repository does not exist** — a model
  name, a package version, an action tag, an API. Your knowledge of what exists
  has a cutoff; the repository does not. A version string you do not recognise
  is far more likely to postdate you than to be wrong, and nothing in the diff
  can settle it either way, so there is no evidence on which to uphold it. Both
  real examples arrived with the date attached, which is the tell: "this model
  likely does not exist yet — as of early 2025 the latest is X", written about
  the model that was serving that very review; and "this action has never
  published a v7.0.1", written about a commit tagged exactly that. Mark these
  not correct.

  This is narrow. It covers *existence* only. How something that does exist
  behaves — a deprecation, a known vulnerability, an API that is easy to hold
  wrong — is still a finding, and still worth making.
- **A claim that a type, interface or schema lacks a member.** Resolve the
  import and read the declaration before agreeing. A name is not unique: a
  repository can hold two interfaces called the same thing in different
  modules, and the one the file imports is the only one that matters. A
  \`critical\` finding asked for a field to be added to a plugin options type
  that declared it, because a second interface with that name elsewhere did
  not. The file under review names its imports; follow them.
- **A guard against a value the types already exclude.** "Handle the case where
  \`x\` is undefined" is a defect when nothing enforces the type and dead code
  when something does. Check where the value comes from: a constant in this
  repository, this service's own earlier write, or an authenticated session is
  not user input, and asking to guard it produces a branch that can never run
  and that the project's own linter would then flag. Eight such findings on one
  pull request were declined with the same sentence.

  Uphold it when the value genuinely crosses a trust boundary, or when it is an
  array element or an index-signature lookup — those are possibly-undefined
  whatever the annotation says. Validation belongs at the boundary; re-checking
  behind it is the thing this rule is about.
- **An option the file already sets** — where a finding asks for one concrete
  option, flag or key to be added, that is decidable by looking for it, and it
  is often already there a few lines away with a comment saying why. One asked
  for \`_id: false\` on a schema that set \`_id: false\` on the line above its own
  explanatory comment. Before agreeing that a named literal is absent, find the
  place it would be written and read it.

## 2. Does it belong on this pull request?

A finding can be perfectly true and still not belong here. Answer \`in_scope\`
false when:

- the condition pre-dates this change and the diff merely sits near it
- it concerns context lines the author did not touch
- it asks for work this change never set out to do
- it is a general improvement to code the PR happened to open
- **it argues against what the change set out to do.** A workflow built to run
  on every push is not improved by a filter that makes it run on fewer; a
  deliberate widening is not a defect because it could have been narrower. If
  the finding would undo the change's stated purpose, it is out of scope, not a
  defect - take that up in the pull request description, not as a review comment.
- **it asks this code to break a pattern the rest of the file or repository
  already follows.** If every other assertion in a test file matches
  case-insensitively, changing only the new one adds inconsistency rather than
  catching a defect. Check the file you have been given before asking for a
  local exception to its own conventions. This does not apply when the pattern
  *is* the defect - a repeated flaw is still a flaw - but then say so, and say
  that it is repeated.
- **the fix requires establishing a convention the repository does not have.**
  A rate limit on one route of a service where no route has one is a proposal,
  not a review comment: it commits the team to a pattern everywhere. Real
  concern, wrong venue - it belongs in its own issue.

- **it asks for a test of behaviour the suite already pins elsewhere.** A
  missing assertion is always genuinely missing, so \`correct\` can never reject
  one of these - this is the question that has to. Before upholding a request
  for a new test or a new assertion, look through the file you have been given
  for a test that already covers the behaviour. A request to assert a response
  status that four sibling tests already assert, or to test a function whose
  round-trip test pins the same property end to end, is redundant, not missing.
  Uphold it when it names the regression that would otherwise pass unnoticed:
  *the empty-trail path takes an early return, so dropping the signature block
  would still go green* is a real gap; *this test could also check \`success\`*
  is not.

Answer it true when the change introduced the problem, made it reachable, or
was plainly the moment to deal with it — a new call to an existing function that
was always unsafe *is* in scope, because this change is what reaches it.

This is not a judgement about size or importance. A one-line fix the change
introduced is in scope; a serious flaw in untouched code is not.

## 3. How much does it matter?

Rate it 1 to 10. **This is a ranking signal, not a gate.** Nothing is dropped
for scoring low — the rating decides what is read first when a change produces
more comments than fit on a screen. Spread your answers out; if everything
scores 2 or 3 the ordering carries no information.

- **9-10** would block the merge: data loss, a security hole, a break on a
  normal path
- **7-8** must fix before this ships: wrong behaviour on a path that occurs in
  practice, or a guarantee the code claims and does not keep
- **5-6** a real defect on an edge case; an unhandled failure of something that
  does fail in production (a network call, a malformed response, an absent
  record); a test that would pass if the behaviour it names were broken, or that
  leaks state into the tests after it
- **3-4** minor — worth saying only if there is little else
- **1-2** trivia: restates the code, pure style no rule requires, a suggestion
  to extract or rename for tidiness, or an extra assertion that would pass
  either way

Most candidates land in 2-5; that is the expected answer, not a failure to
decide.

Two corrections that cut against the instinct to be severe:

- **Small does not mean unwanted.** A cheap, obviously-correct fix tends to get
  made; a deep speculative concern tends to get argued about. Do not rate
  something 1 merely because it is small, and do not assume a finding in a test
  file matters less than one in production code.
- **Severity is not importance.** Judge a finding on what it would cost the
  reader to be wrong about it, not on the label it arrived with. The find pass
  assigns severity before any of this was checked.

A finding is far more useful when it names the repository rule or convention it
rests on, and when it comes with a fix the author can apply.

Give the line that settles the factual question in \`disproof\` when there is one,
and one sentence of evidence in \`reason\`.`;



/**
 * The rules and past corrections, for the verifier as well as the finder.
 *
 * These rendered only in the finding prompt, so the stage that decides what
 * ships never saw them. A reviewed repository banned `as const` in its own
 * checklist; the finder was told, asked for one anyway, and verification had no
 * grounds to refuse because the rule was not in front of it. The same gap made
 * past maintainer corrections advisory rather than binding: a finding argued
 * down on an earlier pull request could be raised again and verified clean.
 */
function conventions(unit: ReviewUnit): string[] {
  const parts: string[] = [];
  // Only stated when the compiler is actually enforcing it. Without
  // `strictNullChecks` TypeScript erases null and undefined from every type, so
  // a non-optional annotation proves nothing and a guard against undefined is a
  // legitimate finding rather than dead code.
  if (unit.strictness?.strictNullChecks) {
    parts.push(
      '\n# What the compiler already guarantees here\n',
      'This project has `strictNullChecks` on and type checks clean, so a value',
      'whose declared type does not include `null` or `undefined` cannot be',
      'either. A guard against it is unreachable code, and the lint rule',
      '`@typescript-eslint/no-unnecessary-condition` exists to flag exactly that.',
      '',
      'Two exceptions, both real:',
      '- values crossing a trust boundary — a request body, an external API',
      '  response, `JSON.parse`, `process.env`, an unvalidated database read.',
      '  The annotation there is a claim, not a guarantee.',
      unit.strictness.noUncheckedIndexedAccess
        ? '- array elements and index-signature lookups, which this project already types as possibly-undefined.'
        : '- array elements and index-signature lookups. TypeScript optimistically types these as defined and they are not; `noUncheckedIndexedAccess` is off here.',
      '',
      'A `Record<K, V>` whose `K` is a finite union of literals is *not* an index',
      'signature: every key exists, and indexing it with a `K` cannot be undefined.',
    );
  }
  if (unit.instructions.length) {
    parts.push(
      '\n# Repository rules\n',
      "From the repository's own instruction files. A finding that asks for something these forbid is out of scope, however sound it is in the abstract.\n",
      ...unit.instructions.slice(0, 40).map((r) => `- ${r}`),
    );
  }
  if (unit.learnings.length) {
    parts.push(
      '\n# What this team has told reviewers before\n',
      'Past corrections from maintainers. Treat them as settled: a finding they have already argued down is out of scope.\n',
      ...unit.learnings.slice(0, 15).map((l) => `- ${l}`),
    );
  }
  return parts;
}

export function buildVerifyPrompt(
  finding: { path: string; startLine: number; endLine: number; title: string; body: string; suggestion?: string },
  unit: ReviewUnit,
  pr?: { title: string; body: string },
): string {
  return [
    // Without this the verifier decides whether a finding belongs on the change
    // while having no idea what the change is for. It upheld a demand to add a
    // `paths-ignore` filter to a workflow whose entire purpose was to run on
    // every push - a finding that argued against the thing being built, and
    // read as reasonable in isolation.
    pr?.title
      ? `# What this pull request is trying to do\n\n${pr.title}\n\n${truncate(pr.body ?? '', 2_000)}\n`
      : '',
    '# Finding under review',
    `File: \`${finding.path}\` lines ${finding.startLine}-${finding.endLine}`,
    `Claim: ${finding.title}`,
    `Reasoning given: ${finding.body}`,
    finding.suggestion ? `Proposed replacement:\n\`\`\`\n${finding.suggestion}\n\`\`\`` : '',
    '',
    '# The change it refers to',
    '```diff',
    truncate(unit.file.patch ?? '', 8_000),
    '```',
    // Only the part of the context that names the anchored file, so the verifier
    // can still check a contract without re-reading everything.
    contextAround(unit, finding.path),
    ...conventions(unit),
    // The verifier could not previously see what the toolchain had already
    // settled, so claims a clean type check refutes outright survived it.
    unit.toolFindings.length
      ? `\n# Static analysis on this file\n\n${unit.toolFindings.slice(0, 30).join('\n')}`
      : unit.toolsRan
        ? '\n# Static analysis on this file\n\nThe type checker and linter ran and reported nothing here. A finding'
          + ' that claims a type error, an unresolved import, an unused symbol or a'
          + ' signature mismatch in this file is contradicted by that and is not correct.'
        : '',
    '',
    '# Task',
    'Decide whether this finding survives. Return JSON matching the schema.',
  ].filter(Boolean).join('\n');
}

/**
 * The context the verifier needs: the anchored file as it stands - which is the
 * first block the retriever produces - plus anything naming the same file.
 * Trimming this to nothing made the verifier refute every finding for lack of
 * evidence, so the file window is not optional.
 */
function contextAround(unit: ReviewUnit, path: string): string {
  const parts: string[] = [];

  // The whole anchored file, when it is small enough to send. A claim that
  // something is unused, never reset or never called is only decidable against
  // the complete text, and those are exactly the claims a verifier gets wrong.
  if (unit.fileText && unit.fileText.length <= 60_000) {
    const numbered = unit.fileText
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(5)}  ${l}`)
      .join('\n');
    parts.push(`\n# The complete file \`${path}\` as it now stands\n\n\`\`\`\n${numbered}\n\`\`\``);
  }

  // ...and the retrieved neighbours, which the whole file does not replace.
  // Returning only the file made the verifier say the imported components "are
  // not provided" and drop its confidence to 0.78 on a correct finding - the
  // components had been retrieved, they were simply thrown away here.
  // Files the finding itself pointed at, which the anchored file cannot show.
  if (unit.namedFiles?.length) {
    parts.push(`\n# Files this finding refers to\n\n` + unit.namedFiles
      .map((n) => `## ${n.label}\n\n\`\`\`\n${truncate(n.text, 6_000)}\n\`\`\``)
      .join('\n\n'));
  }

  if (unit.context.trim()) {
    const blocks = unit.context.split(/\n(?=## )/);
    const chosen = parts.length
      // The file itself is already above; keep what it cannot show.
      ? blocks.slice(1)
      : [blocks[0] ?? '', ...blocks.slice(1).filter((b) => b.includes(path))];
    const text = chosen.filter(Boolean).join('\n');
    if (text.trim()) parts.push(`\n# Surrounding code and related files\n${truncate(text, 14_000)}`);
  }

  return parts.join('\n');
}

/**
 * The verify prompt for a group of findings on the same code.
 *
 * Same instructions as the single case; what changes is that every finding on
 * this region is in front of the verifier at once, so a contradiction between
 * two of them has to be settled rather than silently posted as both.
 */
export function buildGroupVerifyPrompt(
  findings: { path: string; startLine: number; endLine: number; title: string; body: string; suggestion?: string }[],
  unit: ReviewUnit,
  pr?: { title: string; body: string },
): string {
  const list = findings.map((f, i) => [
    `### Finding ${i}`,
    `Lines ${f.startLine}-${f.endLine}`,
    `Claim: ${f.title}`,
    `Reasoning given: ${f.body}`,
    f.suggestion ? `Proposed replacement:\n\`\`\`\n${f.suggestion}\n\`\`\`` : '',
  ].filter(Boolean).join('\n')).join('\n\n');

  const first = findings[0]!;
  return [
    pr?.title
      ? `# What this pull request is trying to do\n\n${pr.title}\n\n${truncate(pr.body ?? '', 2_000)}\n`
      : '',
    `# ${findings.length} finding(s) on \`${first.path}\``,
    findings.length > 1
      ? 'These all point at the same region. Judge each one, and where two report the'
        + ' same underlying defect in different words, mark the later one as a duplicate'
        + ' of the earlier. They must not contradict each other: if one says a test'
        + ' checks something and another says it does not, decide which is true and'
        + ' answer consistently for both.'
      : '',
    '',
    list,
    '',
    '# The change they refer to',
    '```diff',
    truncate(unit.file.patch ?? '', 8_000),
    '```',
    contextAround(unit, first.path),
    ...conventions(unit),
    '',
    '# Task',
    'Return one verdict per finding, using the index shown. Return JSON matching the schema.',
  ].filter(Boolean).join('\n');
}

export const WALKTHROUGH_SYSTEM = `You summarise pull requests for reviewers who have not read the diff.

Be concrete and factual. Name what changed and what it affects. Do not praise,
do not speculate about intent, and do not describe the diff mechanically
("added 3 lines"). Group files by what they accomplish together.`;

export const CHECKS_SYSTEM = `You audit pull request hygiene. Judge only what you are shown.

- Title check: does the title describe the main change specifically?
- Description check: does the body explain what changed and why? An empty or
  template-only body fails.
- Linked issues check: if the PR references issues, do the changes address them?
  If no issue is referenced, pass with that explanation.
- Out of scope changes check: are there changes unrelated to the stated purpose?

Be lenient: warn rather than fail unless something is clearly missing.`;

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}
