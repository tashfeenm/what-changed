// The block differ's tests moved here with the differ (from read-better,
// née adf-codec): comparison is what-changed's job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'read-better';
import { blockDiff } from '../src/core/blockdiff.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const v1 = parse(JSON.parse(readFileSync(join(FIXTURES, 'release-notes-v1.json'), 'utf8')));
const v2 = parse(JSON.parse(readFileSync(join(FIXTURES, 'release-notes-v2.json'), 'utf8')));

test('blockDiff: edits pair up as changed; adds/removes are detected', () => {
  const ops = blockDiff(v1, v2);
  const summaries = ops.map((op) => op.summary);

  assert.ok(summaries.some((s) => /warning panel removed/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /code block \(bash\) edited/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /task list: 2\/3 done \(was 1\)/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /table: 2 → 3 rows/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /section "Comms" added/.test(s)), summaries.join(' | '));

  // Unchanged blocks must not appear.
  assert.ok(!summaries.some((s) => /Rollback.*(added|removed)/.test(s)), summaries.join(' | '));
});

test('blockDiff: identical inputs produce no ops', () => {
  assert.deepEqual(blockDiff(v1, v1), []);
});

test('blockDiff: pure moves are reported as moved, not add/remove', () => {
  const reordered = [...v1.slice(1), v1[0]];
  const ops = blockDiff(v1, reordered);
  assert.ok(ops.every((op) => op.op === 'moved'), JSON.stringify(ops));
  assert.ok(ops.length >= 1);
});
