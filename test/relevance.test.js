import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearWatchFact,
  clearWatchFactsBySource,
  ensureObject,
  openStore,
  reconcileWatchEdges,
  setWatchFact,
  watchIndex,
} from '../src/core/store.js';

function object(db, externalId) {
  return ensureObject(db, {
    connector: 'test',
    externalId,
    objectType: 'issue',
    name: externalId,
    url: null,
  });
}

function rewriteConnectorFacts(db, watchedObject, source, reason) {
  clearWatchFact(db, watchedObject.id, 'assigned');
  clearWatchFact(db, watchedObject.id, 'tracked');
  setWatchFact(db, watchedObject.id, source, { reason });
}

test('watch facts resolve by read-time priority and connector rewrites downgrade naturally', () => {
  const db = openStore(':memory:');
  const blocker = object(db, 'BLOCK-1');
  const assignedThenTracked = object(db, 'ASSIGN-1');

  // A connector reseed cannot shadow a dependency edge just because it was
  // written later: priority is resolved at read time.
  reconcileWatchEdges(db, 'DERIVER-1', [{
    blockerObjectId: blocker.id,
    reason: 'DERIVER-1 is blocked by it',
  }]);
  rewriteConnectorFacts(db, blocker, 'tracked', 'in a tracked repo');
  assert.deepEqual(watchIndex(db).get(blocker.id), {
    source: 'dependency', reason: 'DERIVER-1 is blocked by it', weight: 1,
  });

  rewriteConnectorFacts(db, assignedThenTracked, 'assigned', 'assigned to you');
  assert.deepEqual(watchIndex(db).get(assignedThenTracked.id), {
    source: 'assigned', reason: 'assigned to you', weight: 1,
  });
  rewriteConnectorFacts(db, assignedThenTracked, 'tracked', 'in a tracked repo');
  assert.deepEqual(watchIndex(db).get(assignedThenTracked.id), {
    source: 'tracked', reason: null, weight: 1,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM watches WHERE object_id = ? AND source = 'assigned'")
      .get(assignedThenTracked.id).count,
    0,
  );
});

test('dependency reconciliation forgets only re-observed derivations and preserves shared blockers', () => {
  const db = openStore(':memory:');
  const blocker = object(db, 'BLOCK-2');

  reconcileWatchEdges(db, 'X-1', [{
    blockerObjectId: blocker.id,
    reason: 'X-1 is blocked by it',
  }]);
  reconcileWatchEdges(db, 'Y-1', [{
    blockerObjectId: blocker.id,
    reason: 'Y-1 is blocked by it',
  }]);
  assert.equal(watchIndex(db).get(blocker.id)?.source, 'dependency');

  // The selected reason follows the newest edge, not arbitrary insertion
  // order or the identity of the deriving issue.
  reconcileWatchEdges(db, 'X-1', [{
    blockerObjectId: blocker.id,
    reason: 'X-1 is still blocked by it',
  }]);
  assert.equal(watchIndex(db).get(blocker.id)?.reason, 'X-1 is still blocked by it');

  // Re-observing X without its old link only removes X's edge. Y still
  // independently watches the shared blocker.
  reconcileWatchEdges(db, 'X-1', []);
  assert.deepEqual(watchIndex(db).get(blocker.id), {
    source: 'dependency', reason: 'Y-1 is blocked by it', weight: 1,
  });

  // Once Y is also reconciled without the edge, there is no winner left.
  reconcileWatchEdges(db, 'Y-1', []);
  assert.equal(watchIndex(db).has(blocker.id), false);
});

test('dependency reconciliation preserves existing edges when a replacement is invalid', () => {
  const db = openStore(':memory:');
  const first = object(db, 'ATOMIC-1');
  const second = object(db, 'ATOMIC-2');
  const replacement = object(db, 'ATOMIC-3');

  reconcileWatchEdges(db, 'ATOMIC-DERIVER', [
    { blockerObjectId: first.id, reason: 'first original edge' },
    { blockerObjectId: second.id, reason: 'second original edge' },
  ]);

  assert.throws(
    () => reconcileWatchEdges(db, 'ATOMIC-DERIVER', [
      { blockerObjectId: replacement.id, reason: 'would replace originals' },
      { blockerObjectId: 'not-an-integer', reason: 'invalid replacement' },
    ]),
    /blockerObjectId must be an integer/,
  );

  assert.deepEqual(
    db.prepare(
      `SELECT blocker_object_id, deriving_key, reason
       FROM watch_edges
       WHERE deriving_key = ?
       ORDER BY blocker_object_id`
    ).all('ATOMIC-DERIVER').map((row) => ({ ...row })),
    [
      { blocker_object_id: first.id, deriving_key: 'ATOMIC-DERIVER', reason: 'first original edge' },
      { blocker_object_id: second.id, deriving_key: 'ATOMIC-DERIVER', reason: 'second original edge' },
    ],
  );
});

test('manual facts survive connector rewrites; ignored vetoes until a watch un-ignores', () => {
  const db = openStore(':memory:');
  const watchedObject = object(db, 'MANUAL-1');

  setWatchFact(db, watchedObject.id, 'manual', { reason: 'critical rollout', weight: 2.5 });
  rewriteConnectorFacts(db, watchedObject, 'tracked', 'in a tracked repo');
  assert.deepEqual(watchIndex(db).get(watchedObject.id), {
    source: 'manual', reason: 'critical rollout', weight: 2.5,
  });
  const manualRow = db.prepare(
    "SELECT source, reason, weight FROM watches WHERE object_id = ? AND source = 'manual'"
  ).get(watchedObject.id);
  assert.equal(manualRow.source, 'manual');
  assert.equal(manualRow.reason, 'critical rollout');
  assert.equal(manualRow.weight, 2.5);

  setWatchFact(db, watchedObject.id, 'ignored');
  rewriteConnectorFacts(db, watchedObject, 'assigned', 'assigned to you');
  assert.equal(watchIndex(db).has(watchedObject.id), false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM watches WHERE object_id = ? AND source = 'ignored'")
      .get(watchedObject.id).count,
    1,
  );

  // This is the store operation behind `watch`: clear the persistent veto,
  // then set a manual fact. Existing sync facts are intentionally retained.
  clearWatchFact(db, watchedObject.id, 'ignored');
  setWatchFact(db, watchedObject.id, 'manual', { reason: 'watched manually' });
  assert.deepEqual(watchIndex(db).get(watchedObject.id), {
    source: 'assigned', reason: 'assigned to you', weight: 1,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM watches WHERE object_id = ? AND source = 'ignored'")
      .get(watchedObject.id).count,
    0,
  );
});

test('bulk fact clearing is source-scoped', () => {
  const db = openStore(':memory:');
  const first = object(db, 'BULK-1');
  const second = object(db, 'BULK-2');
  setWatchFact(db, first.id, 'tracked', { reason: 'tracked' });
  setWatchFact(db, second.id, 'tracked', { reason: 'tracked' });
  setWatchFact(db, first.id, 'manual', { reason: 'keep me' });

  clearWatchFactsBySource(db, 'tracked', [first.id]);
  assert.equal(watchIndex(db).get(first.id)?.source, 'manual');
  assert.equal(watchIndex(db).get(second.id)?.source, 'tracked');
});

test('openStore migration is idempotent on a file-backed database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'what-changed-relevance-'));
  const dbPath = join(dir, 'store.db');
  let first;
  let second;
  let third;
  try {
    first = openStore(dbPath);
    assert.deepEqual(
      first.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('watchlist', 'watches', 'watch_edges') ORDER BY name"
      ).all().map((row) => row.name),
      ['watch_edges', 'watches', 'watchlist'],
    );
    first.close();
    first = null;

    // A second startup must preserve data and apply the same migration safely.
    second = openStore(dbPath);
    const watchedObject = object(second, 'MIGRATION-1');
    setWatchFact(second, watchedObject.id, 'manual', { reason: 'persists' });
    second.close();
    second = null;

    third = openStore(dbPath);
    assert.deepEqual(watchIndex(third).get(watchedObject.id), {
      source: 'manual', reason: 'persists', weight: 1,
    });
    third.close();
    third = null;
  } finally {
    first?.close();
    second?.close();
    third?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
