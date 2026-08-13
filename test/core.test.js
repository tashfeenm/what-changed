import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonDiff, canonicalize } from '../src/core/diff.js';
import { openStore, ensureObject, ingestSnapshot, unseenDeltas, markSeen, addMute, gc } from '../src/core/store.js';
import { jiraLens } from '../src/core/lens.js';
import { ingestFixtureFile } from '../src/connectors/fixture.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo');

test('canonicalize sorts keys at every level', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('jsonDiff: scalar replace, add, remove', () => {
  const ops = jsonDiff({ a: 1, b: 'x' }, { a: 2, c: true });
  assert.deepEqual(
    ops.map(({ op, path }) => ({ op, path })).sort((x, y) => x.path.localeCompare(y.path)),
    [
      { op: 'replace', path: '/a' },
      { op: 'remove', path: '/b' },
      { op: 'add', path: '/c' },
    ].sort((x, y) => x.path.localeCompare(y.path))
  );
});

test('jsonDiff: arrays of identifiable objects diff by id, stable under reorder', () => {
  const a = [{ id: 1, v: 'x' }, { id: 2, v: 'y' }];
  const b = [{ id: 2, v: 'y' }, { id: 1, v: 'z' }];
  const ops = jsonDiff(a, b);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].path, '/1/v');
  assert.equal(ops[0].after, 'z');
});

test('identical payload is a no-op; changed payload produces lensed deltas', () => {
  const db = openStore(':memory:');
  const object = ensureObject(db, {
    connector: 'jira', externalId: 'T-1', objectType: 'issue', name: 'T-1 Test', url: 'https://x/T-1',
  });
  const payload = { key: 'T-1', status: 'To Do', comment_count: 0 };
  ingestSnapshot(db, object, payload, { lens: jiraLens });
  const again = ingestSnapshot(db, object, { ...payload }, { lens: jiraLens });
  assert.equal(again.changed, false);

  const moved = ingestSnapshot(db, object, { ...payload, status: 'Done', comment_count: 2 }, { lens: jiraLens });
  assert.equal(moved.changed, true);
  const summaries = moved.deltas.map((d) => d.summary).sort();
  assert.deepEqual(summaries, ['2 new comments', 'status: To Do → Done']);
});

test('seen baseline: markSeen clears the digest; mutes filter kinds', () => {
  const db = openStore(':memory:');
  ingestFixtureFile(db, join(FIXTURES, 'monday.json'));
  assert.equal(unseenDeltas(db).length, 3); // three 'created' sightings
  markSeen(db);
  assert.equal(unseenDeltas(db).length, 0);

  ingestFixtureFile(db, join(FIXTURES, 'tuesday.json'));
  const rows = unseenDeltas(db);
  assert.ok(rows.length >= 5, `expected >=5 deltas, got ${rows.length}`);
  assert.ok(rows.some((r) => r.summary.includes('status: In Progress → In Review')));
  assert.ok(rows.some((r) => r.summary.includes('priority: High → Highest')));
  assert.ok(rows.some((r) => r.summary === 'marked ready for review'));

  // ADF codec integration: description edits arrive as block-level content deltas.
  assert.ok(rows.some((r) => r.kind === 'content' && /description: paragraph .* edited/.test(r.summary)),
    rows.map((r) => r.summary).join(' | '));
  assert.ok(rows.some((r) => r.kind === 'content' && /warning panel removed/.test(r.summary)));

  addMute(db, 'kind', 'comment');
  assert.ok(unseenDeltas(db).every((r) => r.kind !== 'comment'));
});

test('gc: drops aged non-head payloads only after their deltas are seen', () => {
  const db = openStore(':memory:');
  ingestFixtureFile(db, join(FIXTURES, 'monday.json'));
  ingestFixtureFile(db, join(FIXTURES, 'tuesday.json'));

  // Unseen deltas reference the monday snapshots — nothing may drop yet.
  assert.equal(gc(db, { retainDays: 0 }), 0);

  markSeen(db);
  const dropped = gc(db, { retainDays: 0 });
  assert.ok(dropped >= 1, `expected drops, got ${dropped}`);

  // Heads keep payloads (needed for the next diff); hashes survive everywhere.
  const rows = db.prepare(
    `SELECT s.id, s.payload, s.payload_hash,
            (s.id IN (SELECT last_snapshot_id FROM objects)) AS is_head
     FROM snapshots s`
  ).all();
  assert.ok(rows.every((r) => r.payload_hash));
  assert.ok(rows.filter((r) => r.is_head).every((r) => r.payload !== null));
  assert.ok(rows.filter((r) => !r.is_head).every((r) => r.payload === null));
});
