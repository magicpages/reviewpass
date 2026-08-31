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
import { collapseNearDuplicates, redundantTestRequest } from '../src/review/run.js';
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
