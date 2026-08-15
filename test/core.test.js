import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonDiff, canonicalize } from '../src/core/diff.js';
import {
  openStore,
  ensureObject,
  ingestSnapshot,
  unseenDeltas,
  markSeen,
  addMute,
  gc,
  getCursor,
  resolveLabeledSnapshot,
  labeledSnapshots,
  setCursor,
} from '../src/core/store.js';
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

test('cursors round-trip, upsert, scope independently, and refresh updated_at', () => {
  const db = openStore(':memory:');

  assert.equal(getCursor(db, 'jira', 'project = TERRA'), null);

  setCursor(db, 'jira', 'project = TERRA', '2026-01-01T00:00:00.000Z');
  assert.equal(getCursor(db, 'jira', 'project = TERRA'), '2026-01-01T00:00:00.000Z');

  setCursor(db, 'jira', 'project = TERRA', '2026-01-02T00:00:00.000Z');
  assert.equal(getCursor(db, 'jira', 'project = TERRA'), '2026-01-02T00:00:00.000Z');

  setCursor(db, 'jira', 'project = ATLAS', '2026-01-03T00:00:00.000Z');
  assert.equal(getCursor(db, 'jira', 'project = TERRA'), '2026-01-02T00:00:00.000Z');
  assert.equal(getCursor(db, 'jira', 'project = ATLAS'), '2026-01-03T00:00:00.000Z');

  const oldUpdatedAt = '2000-01-01T00:00:00.000Z';
  db.prepare('UPDATE cursors SET updated_at = ? WHERE connector = ? AND scope = ?')
    .run(oldUpdatedAt, 'jira', 'project = TERRA');
  assert.equal(
    db.prepare('SELECT updated_at FROM cursors WHERE connector = ? AND scope = ?')
      .get('jira', 'project = TERRA').updated_at,
    oldUpdatedAt
  );

  setCursor(db, 'jira', 'project = TERRA', '2026-01-04T00:00:00.000Z');
  const refreshed = db.prepare('SELECT cursor_value, updated_at FROM cursors WHERE connector = ? AND scope = ?')
    .get('jira', 'project = TERRA');
  assert.equal(refreshed.cursor_value, '2026-01-04T00:00:00.000Z');
  assert.notEqual(refreshed.updated_at, oldUpdatedAt);
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

test('ingestSnapshot rolls back when a custom differ throws', () => {
  const db = openStore(':memory:');
  const object = ensureObject(db, {
    connector: 'test', externalId: 'rollback-differ', objectType: 'item', name: 'Rollback differ', url: null,
  });
  const first = ingestSnapshot(db, object, { value: 'before' });
  const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count;
  const deltaCount = db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count;

  assert.throws(
    () => ingestSnapshot(db, object, { value: 'after' }, {
      differs: { value: () => { throw new Error('differ failed'); } },
    }),
    /differ failed/
  );

  const head = db.prepare('SELECT last_snapshot_id FROM objects WHERE id = ?').get(object.id);
  assert.equal(Number(head.last_snapshot_id), first.snapshotId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, snapshotCount);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count, deltaCount);
});

test('ingestSnapshot rolls back inserted deltas when a lens throws', () => {
  const db = openStore(':memory:');
  const object = ensureObject(db, {
    connector: 'test', externalId: 'rollback-lens', objectType: 'item', name: 'Rollback lens', url: null,
  });
  const first = ingestSnapshot(db, object, { first: 'before', second: 'before' });
  const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count;
  const deltaCount = db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count;
  let lensCalls = 0;

  assert.throws(
    () => ingestSnapshot(db, object, { first: 'after', second: 'after' }, {
      lens: () => {
        lensCalls += 1;
        if (lensCalls === 2) throw new Error('lens failed');
        return null;
      },
    }),
    /lens failed/
  );

  const head = db.prepare('SELECT last_snapshot_id FROM objects WHERE id = ?').get(object.id);
  assert.equal(lensCalls, 2);
  assert.equal(Number(head.last_snapshot_id), first.snapshotId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, snapshotCount);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count, deltaCount);
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
  // Make the retention condition deterministic rather than relying on a
  // just-created timestamp landing before a zero-day cutoff.
  db.prepare(
    `UPDATE snapshots SET taken_at = ?
     WHERE id NOT IN (SELECT last_snapshot_id FROM objects WHERE last_snapshot_id IS NOT NULL)`
  ).run('2000-01-01T00:00:00.000Z');
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

test('capture labels resolve only captured series and list in stable order', () => {
  const db = openStore(':memory:');
  const first = ensureObject(db, {
    connector: 'capture', externalId: 'alpha-series', objectType: 'capture', name: 'alpha-series', url: null,
  });
  const second = ensureObject(db, {
    connector: 'capture', externalId: 'beta-series', objectType: 'capture', name: 'beta-series', url: null,
  });
  const tracked = ensureObject(db, {
    connector: 'fixture', externalId: 'tracked', objectType: 'item', name: 'tracked', url: null,
  });

  ingestSnapshot(db, first, { format: 'a11y', content: 'first' }, { label: 'build-123' });
  ingestSnapshot(db, second, { format: 'json', content: 'second' }, { label: 'build-123' });
  ingestSnapshot(db, first, { format: 'openapi', content: 'third' }, { label: 'release' });
  ingestSnapshot(db, tracked, { value: 'ignored for captured lookup' }, { label: 'tracked-only' });

  // Equal timestamps must fall back to snapshots.id, not an arbitrary order.
  db.prepare('UPDATE snapshots SET taken_at = ? WHERE object_id IN (?, ?)')
    .run('2026-01-01T00:00:00.000Z', first.id, second.id);

  assert.deepEqual(
    labeledSnapshots(db).map(({ series, label, format }) => ({ series, label, format })),
    [
      { series: 'alpha-series', label: 'build-123', format: 'a11y' },
      { series: 'beta-series', label: 'build-123', format: 'json' },
      { series: 'alpha-series', label: 'release', format: 'openapi' },
    ]
  );
  assert.deepEqual(
    labeledSnapshots(db, { series: 'alpha-series' }).map(({ label, format }) => ({ label, format })),
    [
      { label: 'build-123', format: 'a11y' },
      { label: 'release', format: 'openapi' },
    ]
  );
  assert.equal(resolveLabeledSnapshot(db, 'build-123', { series: 'alpha-series' }).series, 'alpha-series');
  assert.throws(
    () => resolveLabeledSnapshot(db, 'build-123'),
    /capture label build-123 is ambiguous across series: alpha-series, beta-series/
  );
  assert.throws(() => resolveLabeledSnapshot(db, 'tracked-only'), /capture label tracked-only not found/);
  assert.throws(() => resolveLabeledSnapshot(db, '   '), /label must not be empty/);
  assert.throws(() => labeledSnapshots(db, { series: '   ' }), /series must not be empty/);
});

test('openStore repairs duplicate labels collision-safely before creating the unique index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'what-changed-label-migration-'));
  const dbPath = join(dir, 'store.db');
  let db;
  try {
    db = openStore(dbPath);
    const object = ensureObject(db, {
      connector: 'capture', externalId: 'migration-series', objectType: 'capture', name: 'migration-series', url: null,
    });
    db.exec('DROP INDEX idx_snapshots_object_label_unique');
    const insert = db.prepare(
      'INSERT INTO snapshots (object_id, taken_at, label, payload_hash, payload) VALUES (?, ?, ?, ?, ?)'
    );
    const firstId = Number(insert.run(object.id, '2026-01-01T00:00:00.000Z', 'x', 'one', '{}').lastInsertRowid);
    const duplicateId = Number(insert.run(object.id, '2026-01-01T00:00:01.000Z', 'x', 'two', '{}').lastInsertRowid);
    insert.run(object.id, '2026-01-01T00:00:02.000Z', `x~${duplicateId}`, 'three', '{}');
    db.close();
    db = null;

    db = openStore(dbPath);
    assert.deepEqual(
      db.prepare('SELECT id, label FROM snapshots ORDER BY id').all().map(({ id, label }) => ({ id, label })),
      [
        { id: firstId, label: 'x' },
        { id: duplicateId, label: `x~${duplicateId}~${duplicateId}` },
        { id: duplicateId + 1, label: `x~${duplicateId}` },
      ]
    );
    assert.match(
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_snapshots_object_label_unique'").get().sql,
      /CREATE UNIQUE INDEX[\s\S]*WHERE label IS NOT NULL/
    );
    const duplicateInsert = db.prepare(
      'INSERT INTO snapshots (object_id, taken_at, label, payload_hash, payload) VALUES (?, ?, ?, ?, ?)'
    );
    assert.throws(
      () => duplicateInsert.run(object.id, '2026-01-01T00:00:03.000Z', 'x', 'four', '{}'),
      /UNIQUE constraint failed: snapshots\.object_id, snapshots\.label/
    );
    db.close();
    db = null;

    // Reopening after the repair is a no-op: it does not extend suffixes again.
    db = openStore(dbPath);
    assert.equal(
      db.prepare('SELECT label FROM snapshots WHERE id = ?').get(duplicateId).label,
      `x~${duplicateId}~${duplicateId}`
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture label unique index is a race-proof ingest backstop', () => {
  const db = openStore(':memory:');
  const object = ensureObject(db, {
    connector: 'capture', externalId: 'backstop-series', objectType: 'capture', name: 'backstop-series', url: null,
  });
  const first = ingestSnapshot(db, object, { format: 'json', content: '{"version":1}' }, { label: 'build-1' });

  assert.throws(
    () => ingestSnapshot(db, object, { format: 'json', content: '{"version":2}' }, { label: 'build-1' }),
    /label build-1 already exists in series backstop-series/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE object_id = ?').get(object.id).count, 1);
  assert.equal(
    Number(db.prepare('SELECT last_snapshot_id FROM objects WHERE id = ?').get(object.id).last_snapshot_id),
    first.snapshotId
  );
});

test('custom differs receive both full payloads as a third argument', () => {
  const db = openStore(':memory:');
  const object = ensureObject(db, {
    connector: 'test', externalId: 'differ-context', objectType: 'item', name: 'Differ context', url: null,
  });
  const before = { format: 'a11y', content: 'before', unchanged: true };
  const after = { format: 'a11y', content: 'after', unchanged: true };
  ingestSnapshot(db, object, before);
  let context;

  ingestSnapshot(db, object, after, {
    differs: {
      content: (oldContent, newContent, receivedContext) => {
        context = receivedContext;
        return [{
          op: 'replace', path: '/content', before: oldContent, after: newContent,
          kind: 'content', summary: 'content changed',
        }];
      },
    },
  });

  assert.deepEqual(context, { prevPayload: before, newPayload: after });
});

test('first-sighting deltas use call-level provenance', () => {
  const db = openStore(':memory:');
  const object = ensureObject(db, {
    connector: 'capture', externalId: 'provenance-series', objectType: 'capture', name: 'provenance-series', url: null,
  });
  ingestSnapshot(db, object, { format: 'json', content: '{}' }, { provenanceUrl: '/tmp/captured.json' });

  assert.equal(
    db.prepare("SELECT provenance_url FROM deltas WHERE kind = 'created'").get().provenance_url,
    '/tmp/captured.json'
  );
});

test('gc retains a labeled capture that is no longer the head', () => {
  const db = openStore(':memory:');
  const object = ensureObject(db, {
    connector: 'capture', externalId: 'retained-series', objectType: 'capture', name: 'retained-series', url: null,
  });
  const first = ingestSnapshot(db, object, { format: 'json', content: '{"version":1}' }, { label: 'v1' });
  ingestSnapshot(db, object, { format: 'json', content: '{"version":2}' });
  markSeen(db);

  assert.equal(gc(db, { retainDays: 0 }), 0);
  assert.notEqual(db.prepare('SELECT payload FROM snapshots WHERE id = ?').get(first.snapshotId).payload, null);
});
