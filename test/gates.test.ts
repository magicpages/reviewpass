/**
 * The deterministic half of the evaluation, and the only half that belongs in
 * CI.
 *
 * Every case here is invented. That is deliberate: the findings these rules
 * were learned from are review threads on a private repository, and renaming
 * the identifiers does not launder them — a finding body still quotes query
 * shapes and describes real architecture. What is portable is the *lesson*, so
 * each test states a rule the reviewer must obey and gives the smallest made-up
 * finding that exercises it.
 *
 * This is a regression suite, not a benchmark, and the difference decides how
 * to read a green run. It is expected to sit at 100% and stay there; passing
 * means today's change did not resurrect a false positive that was already
 * fixed. It says nothing about how good the reviewer is. Nothing here calls a
 * model, so it is free, offline, and identical on every run.
 *
 * How good the reviewer actually is cannot be measured this way. That needs
 * real model calls against real triaged findings, it costs money, and it
 * carries a two-finding noise floor that makes any small movement unreadable.
 * Keep that measurement out of CI and run it deliberately.
 *
 * When a false positive escapes onto a live pull request, add the rule it broke
 * here. The suite is only ever as good as the last thing that got past it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collapseNearDuplicates, redundantTestRequest, citationResolves, guardsImpossibleState } from '../src/review/run.js';
import type { Finding } from '../src/types.js';

const finding = (over: Partial<Finding>): Finding => ({
  path: 'src/service.ts', startLine: 10, endLine: 10, severity: 'minor',
  category: 'correctness', title: 'placeholder', body: 'placeholder', ...over,
} as Finding);

describe('redundantTestRequest', () => {
  /**
   * Asking for a whole new test and asking for a stronger assertion inside an
   * existing one read alike and behave nothing alike. By the time a review
   * runs, the author has already written the tests that ship with the change,
   * so the first is usually redundant with one in the same diff and the second
   * is a real gap. Only the first is caught here.
   */
  test('drops a new-test request whose subject the suite already exercises', () => {
    const hit = redundantTestRequest(
      { title: 'Add tests for `reconcileInventory` covering the failure path', body: '' },
      new Set(['reconcileInventory', 'unrelatedHelper']),
    );
    assert.equal(hit, 'reconcileInventory');
  });

  test('keeps a new-test request when no test mentions the subject', () => {
    const hit = redundantTestRequest(
      { title: 'Add tests for `reconcileInventory` covering the failure path', body: '' },
      new Set(['unrelatedHelper']),
    );
    assert.equal(hit, null, 'a genuine coverage gap must survive the gate');
  });

  test('never fires on a name common to every test file', () => {
    // A gate keyed on `href` or `findOne` would retire findings about code
    // nobody has tested, because those appear in every suite in the repository.
    for (const generic of ['href', 'findOne', 'result', 'expect', 'value']) {
      assert.equal(
        redundantTestRequest(
          { title: `Add a test for \`${generic}\` handling`, body: '' },
          new Set([generic]),
        ),
        null,
        `must not retire a finding on the generic name ${generic}`,
      );
    }
  });

  test('leaves a request for a stronger assertion alone', () => {
    const covered = new Set(['reconcileInventory']);
    for (const title of [
      'Assert `reconcileInventory` is called with the resolved batch',
      'Test does not verify the rejection path is reached',
      'Assert the mock was called exactly once',
    ]) {
      assert.equal(
        redundantTestRequest({ title, body: '' }, covered), null,
        `assertion request was wrongly retired: ${title}`,
      );
    }
  });

  test('does nothing when the workspace yielded no test symbols', () => {
    // An empty index means the scan failed, not that the repository has no
    // tests. Failing open is the only safe direction for a gate that deletes.
    assert.equal(
      redundantTestRequest(
        { title: 'Add tests for `reconcileInventory`', body: '' },
        new Set(),
      ),
      null,
    );
  });
});

describe('collapseNearDuplicates', () => {
  test('merges two wordings of one defect on the same lines', () => {
    const out = collapseNearDuplicates([
      finding({ title: 'Log and continue when the upsert fails', body: 'The failed upsert is swallowed here.' }),
      finding({ title: 'Log and continue on a failed upsert', body: 'The failed upsert is swallowed silently.' }),
    ]);
    assert.equal(out.length, 1);
  });

  test('keeps two genuinely different defects on the same lines', () => {
    // Loosening this rule was tried and merged distinct defects in one
    // function, which loses a real finding to tidy the output.
    const out = collapseNearDuplicates([
      finding({ title: 'Log and continue when the upsert fails', body: 'The failed upsert is swallowed here.' }),
      finding({ title: 'Await the promise before returning', body: 'The caller sees a value that is not ready.' }),
    ]);
    assert.equal(out.length, 2, 'distinct defects must not be merged');
  });

  test('merges one root cause reported in a file and again in its test', () => {
    const out = collapseNearDuplicates([
      finding({ path: 'src/service.ts', title: 'The signature omits the second argument', body: 'The call passes one argument where two are required.' }),
      finding({ path: 'src/service.test.ts', startLine: 90, endLine: 90, title: 'The signature omits the second argument', body: 'The call passes one argument where two are required.' }),
    ]);
    assert.equal(out.length, 1, 'one defect seen twice is still one defect');
  });
});

describe('citationResolves', () => {
  /**
   * A finding must quote the line that proves it, and the quote must be there.
   * The refutations this exists to prevent all named a location the reviewer
   * had never opened; the findings that provoked them named none.
   */
  const file = [
    'export function widgetLimit(input: string | undefined) {',
    '  if (!input) return 0;',
    '  return Number.parseInt(input, 10);',
    '}',
  ].join('\n');
  const read = (p: string) => (p === 'src/limit.ts' ? file : null);

  test('accepts a quote that is really on the cited line', () => {
    const r = citationResolves({ path: 'src/limit.ts', line: 2, quote: 'if (!input) return 0;' }, read);
    assert.equal(r.ok, true);
  });

  test('accepts a quote whose line number drifted by a few', () => {
    // The model counts hunk headers and blank lines inconsistently. Failing a
    // true finding over a two-line offset would trade one error for another.
    const r = citationResolves({ path: 'src/limit.ts', line: 4, quote: 'if (!input) return 0;' }, read);
    assert.equal(r.ok, true);
  });

  test('accepts a requoted line whose whitespace and quotes differ', () => {
    const r = citationResolves(
      { path: 'src/limit.ts', line: 3, quote: "return Number.parseInt( input , 10 );" }, read);
    assert.equal(r.ok, true);
  });

  test('rejects a quote that appears nowhere in the file', () => {
    const r = citationResolves(
      { path: 'src/limit.ts', line: 2, quote: 'if (!input) throw new RangeError();' }, read);
    assert.equal(r.ok, false);
  });

  test('rejects a citation to a file that is not in the workspace', () => {
    const r = citationResolves({ path: 'src/imagined.ts', line: 1, quote: 'anything at all' }, read);
    assert.equal(r.ok, false);
  });

  test('rejects a finding that cites nothing', () => {
    assert.equal(citationResolves(undefined, read).ok, false);
  });

  test('rejects an empty or near-empty quote', () => {
    // Without this the field is satisfied by a space and proves nothing.
    for (const quote of ['', ' ', '  }', 'x']) {
      assert.equal(citationResolves({ path: 'src/limit.ts', line: 1, quote }, read).ok, false,
        `an empty quote must not satisfy the requirement: ${JSON.stringify(quote)}`);
    }
  });
});

describe('citationResolves — what its own review caught', () => {
  const file = ['function run() {', '  return true;', '}'].join('\n');
  const read = (p: string) => (p === 'src/run.ts' ? file : null);

  test('rejects a real line with fabricated text appended', () => {
    // The gate exists to catch a claim about code nobody read. An earlier
    // version accepted any quote that *contained* a real line, so appending an
    // invention to a true line passed - the exact move it was built to stop.
    const r = citationResolves(
      { path: 'src/run.ts', line: 2, quote: 'return true; and this is never awaited' }, read);
    assert.equal(r.ok, false);
  });

  test('accepts a quote spanning more than one line', () => {
    // The prompt asks for the line as it appears and does not promise one line.
    const r = citationResolves(
      { path: 'src/run.ts', line: 1, quote: 'function run() { return true;' }, read);
    assert.equal(r.ok, true);
  });

  test('rejects a citation with no file named', () => {
    for (const path of ['', '   ']) {
      assert.equal(citationResolves({ path, line: 1, quote: 'return true;' }, read).ok, false);
    }
  });
});

describe('reply classification', () => {
  // Shared verbatim with src/store/derive.ts, because the benchmark's idea of
  // an accepted finding has to be the reviewer's idea of one. Two graders drift
  // apart inside a month and the score starts measuring the gap between them.
  const ACCEPTANCE = /^\s*(fixed|done|good catch|thanks|addressed|resolved|applied|will do|agreed)\b/i;
  const DECLINED = /\b(no change|no defect|no action|nothing to change|not fixing|already (fixed|covered|present|handled)|no bug|no issue)s?\b/i;
  const confirms = (body: string) => ACCEPTANCE.test(body) && !DECLINED.test(body.slice(0, 200));

  test('a polite refusal is not an acceptance', () => {
    // These opened with "agreed", so every one was filed as a confirmed finding
    // and none was recorded as rejected. The reviewer was being taught that its
    // own withdrawn hypotheses land well.
    for (const reply of [
      'Agreed — no defect, nothing to change.',
      'Agreed, no change needed — filing as acknowledged.',
      'Agreed - no changes needed',
      'Agreed, no action — the TTL index is intentional.',
      'Agreed - no bugs here',
      'Agreed - no issues found',
    ]) {
      assert.equal(confirms(reply), false, `counted as acceptance: ${reply}`);
    }
  });

  test('a reply that says a change was made is an acceptance', () => {
    for (const reply of [
      'Fixed in abc1234: added the assertion.',
      'Good catch, done in def5678.',
      'Addressed — the guard now returns early.',
      'Agreed, and fixed in 0a13889.',
    ]) {
      assert.equal(confirms(reply), true, `not counted as acceptance: ${reply}`);
    }
  });
});

describe('guardsImpossibleState', () => {
  /**
   * The biggest class of rejected findings: a guard demanded for a state the
   * schema does not permit. The phrasing alone is a weak signal — findings
   * worded this way are accepted about as often as any other — so the trigger
   * is broad and every bit of the discrimination comes from the schema.
   */
  const required = new Set(['lockedAt', 'method', 'lockRecord']);

  test('drops a null guard on a field the schema declares required', () => {
    assert.equal(
      guardsImpossibleState(
        { title: 'Handle potential null `lockedAt` before calling toISOString()', body: '' },
        required),
      'lockedAt');
  });

  test('drops a partial-shape guard on an all-required subdocument', () => {
    assert.equal(
      guardsImpossibleState(
        { title: 'Handle the case where account.lockRecord has an unexpected shape', body: '' },
        required),
      'lockRecord');
  });

  test('keeps a guard on a field the schema does not require', () => {
    assert.equal(
      guardsImpossibleState(
        { title: 'Handle potential null `nickname` before calling trim()', body: '' },
        required),
      null, 'an optional field is a real guard and must survive');
  });

  test('keeps a finding that is not asking for a guard', () => {
    // The trigger is broad on purpose; it must still not catch everything that
    // happens to mention a required field.
    for (const title of [
      'Rename `lockedAt` to `blockedOn` for consistency',
      'Assert `method` is included in the response payload',
      'Index `lockedAt` so the cleanup query does not scan',
    ]) {
      assert.equal(guardsImpossibleState({ title, body: '' }, required), null,
        `wrongly treated as an impossible-state guard: ${title}`);
    }
  });

  test('does nothing when no schema was indexed', () => {
    // An empty index means the scan found no models, not that nothing is
    // required. Failing open is the only safe direction for a gate that drops.
    assert.equal(
      guardsImpossibleState({ title: 'Handle potential null `lockedAt`', body: '' }, new Set()),
      null);
  });
});
