import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, clearWatchFact, watchIndex } from '../src/core/store.js';
import { deriveGithubWatch, normalize, sync } from '../src/connectors/github.js';

const REPO = 'acme/widgets';

function rawIssue({ assigned = false } = {}) {
  return {
    number: 42,
    title: 'Avoid an overnight checkout outage',
    state: 'open',
    html_url: 'https://github.com/acme/widgets/issues/42',
    assignees: assigned ? [{ login: 'viewer' }] : [{ login: 'someone-else' }],
    labels: [{ name: 'payments' }],
    milestone: { title: 'Q3' },
    comments: 3,
    body: 'Body text must stay redacted from the snapshot.',
    updated_at: '2026-08-13T10:00:00Z',
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function githubObject(db) {
  return db.prepare(
    'SELECT * FROM objects WHERE connector = ? AND external_id = ?'
  ).get('github', `${REPO}#42`);
}

test('GitHub watch derivation is exact and normalize keeps its established payload shape', () => {
  assert.deepEqual(
    deriveGithubWatch({ assignees: [{ login: 'viewer' }] }, 'viewer'),
    { source: 'assigned', reason: 'assigned to you' }
  );
  assert.deepEqual(
    deriveGithubWatch({ assignees: [{ login: 'someone-else' }] }, 'viewer'),
    { source: 'tracked', reason: 'in a tracked repo' }
  );
  assert.deepEqual(
    deriveGithubWatch({ assignees: [{ login: 'viewer' }] }, null),
    { source: 'tracked', reason: 'in a tracked repo' }
  );

  assert.deepEqual(Object.keys(normalize(rawIssue())).sort(), [
    'assignees',
    'body_hash',
    'comments',
    'draft',
    'is_pr',
    'labels',
    'merged',
    'milestone',
    'number',
    'state',
    'title',
    'updated_at',
  ]);
});

test('GitHub sync looks up the viewer once, seeds assigned, and reseeds without payload churn', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const issue = rawIssue({ assigned: true });
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === 'https://api.github.com/user') return jsonResponse({ login: 'viewer' });
    if (new URL(target).pathname === `/repos/${REPO}/issues`) return jsonResponse([issue]);
    throw new Error(`unexpected fetch: ${target}`);
  };

  try {
    const db = openStore(':memory:');
    const first = await sync(db, { repos: [REPO] }, { GITHUB_TOKEN: 'token' });
    const object = githubObject(db);
    assert.equal(first.changed, 1);
    assert.equal(calls.filter((url) => url === 'https://api.github.com/user').length, 1);
    assert.deepEqual(watchIndex(db).get(object.id), {
      source: 'assigned', reason: 'assigned to you', weight: 1,
    });

    const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count;
    const deltaCount = db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count;
    clearWatchFact(db, object.id, 'assigned');
    assert.equal(watchIndex(db).has(object.id), false);

    const second = await sync(db, { repos: [REPO] }, { GITHUB_TOKEN: 'token' });
    assert.equal(second.changed, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, snapshotCount);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count, deltaCount);
    assert.equal(calls.filter((url) => url === 'https://api.github.com/user').length, 2);
    assert.deepEqual(watchIndex(db).get(object.id), {
      source: 'assigned', reason: 'assigned to you', weight: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub viewer lookup failure quietly degrades watch seeding to tracked', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === 'https://api.github.com/user') return jsonResponse({ message: 'unavailable' }, 503);
    if (new URL(target).pathname === `/repos/${REPO}/issues`) return jsonResponse([rawIssue({ assigned: true })]);
    throw new Error(`unexpected fetch: ${target}`);
  };

  try {
    const db = openStore(':memory:');
    await sync(db, { repos: [REPO] }, { GITHUB_TOKEN: 'token' });
    const object = githubObject(db);
    assert.equal(calls.filter((url) => url === 'https://api.github.com/user').length, 1);
    assert.deepEqual(watchIndex(db).get(object.id), {
      source: 'tracked', reason: null, weight: 1,
    });
    const stored = db.prepare('SELECT source, reason FROM watches WHERE object_id = ?').get(object.id);
    assert.equal(stored.source, 'tracked');
    assert.equal(stored.reason, 'in a tracked repo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
