/**
 * What a benchmark run records about its findings, and how runs are filed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collidingKeys, findingMeta } from '../benchmark/runs.js';

test('a finding with nothing recorded about it carries no meta', () => {
  assert.equal(findingMeta({ title: 'a raw finding' }), undefined, 'an empty meta would mark it as filterable');
  assert.deepEqual(findingMeta({ severity: 'minor', samples: [0, 2] }), { severity: 'minor', samples: [0, 2] });
});

test('methods whose keys would share run files are found', () => {
  assert.deepEqual(collidingKeys(['raw@m@low@1#a/b', 'raw@m@low@1#a:b', 'raw@m@low@1#c']), [['raw@m@low@1#a/b', 'raw@m@low@1#a:b']]);
  assert.deepEqual(collidingKeys(['raw@m@low@1', 'reviewpass@m@low@1', 'reviewpass@m@low@1+verify=v#meta']), []);
});
