import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shareExactContext, preferShorterText } from './presentation-sharing.js';

test('shares only equal ordered context without losing rows or multiplicity', () => {
  const a = { repo: 'a', snapshot: 'head', endLine: 2, confidence: 'high', basis: 'x', evidence: [1, 2] };
  const rows = [a, { ...a, evidence: [1, 2] }, { ...a, repo: 'b' }, { ...a, snapshot: 'base' }, { ...a, endLine: 3 }, { ...a, confidence: 'low' }, { ...a, basis: 'y' }, { ...a, evidence: [2, 1] }, a];
  const before = structuredClone(rows);
  const result = shareExactContext(rows, row => row);
  assert.deepEqual(result.contexts, [a, rows[2], rows[3], rows[4], rows[5], rows[6], rows[7]]);
  assert.deepEqual(result.rows.map(row => row.contextIndex), [0, 0, 1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(result.rows.map(row => row.value), rows);
  assert.deepEqual(rows, before);
});

test('chooses shorter complete UTF-8 layout and keeps literal on ties', () => {
  assert.equal(preferShorterText('abc', 'xy'), 'xy');
  assert.equal(preferShorterText('abc', 'xyz'), 'abc');
  assert.equal(preferShorterText('abc', 'éé'), 'abc');
});

test('scores complete line blocks including UTF-8 and terminating newlines', async () => {
  const { blockBytes } = await import('./presentation-sharing.ts');
  assert.equal(blockBytes([]), 0);
  assert.equal(blockBytes(['é', 'a']), 5);
});
