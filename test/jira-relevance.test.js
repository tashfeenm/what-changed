import test from 'node:test';
import assert from 'node:assert/strict';
import { clearWatchFact, openStore, watchIndex } from '../src/core/store.js';
import { deriveBlockerKeys, deriveJiraWatch, normalize, sync } from '../src/connectors/jira.js';

const ENV = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'you@example.test',
  JIRA_API_TOKEN: 'token',
};

function issue(key, { accountId = null, links = [] } = {}) {
  return {
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { name: 'Open' },
      assignee: accountId == null ? null : { accountId, displayName: 'You' },
      priority: { name: 'Medium' },
      labels: [],
      comment: { total: 0, comments: [] },
      issuelinks: links,
      description: null,
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('deriveJiraWatch only marks a matching non-null account as assigned', () => {
  assert.deepEqual(deriveJiraWatch(issue('PROJ-1', { accountId: 'me' }), 'me'), {
    source: 'assigned', reason: 'assigned to you',
  });
  assert.deepEqual(deriveJiraWatch(issue('PROJ-1', { accountId: 'someone-else' }), 'me'), {
    source: 'tracked', reason: 'matches your JQL scope',
  });
  assert.deepEqual(deriveJiraWatch(issue('PROJ-1'), 'me'), {
    source: 'tracked', reason: 'matches your JQL scope',
  });
  assert.deepEqual(deriveJiraWatch(issue('PROJ-1', { accountId: 'me' }), null), {
    source: 'tracked', reason: 'matches your JQL scope',
  });

  // Relevance must remain outside the normalized payload boundary. Snapshot
  // identity is intentionally unchanged by the connector's watch additions.
  assert.deepEqual(Object.keys(normalize(issue('PROJ-1'))).sort(), [
    'assignee',
    'comment_count',
    'description_adf',
    'key',
    'labels',
    'last_comment_hash',
    'links',
    'priority',
    'status',
    'summary',
  ]);
});

test('deriveBlockerKeys accepts only raw inward is-blocked-by links with valid keys', () => {
  const links = [
    { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PROJ-42' } },
    // The same relationship wording on an outward issue describes the wrong
    // direction for this issue and must not become a blocker edge.
    { type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'PROJ-43' } },
    { type: { inward: 'relates to' }, inwardIssue: { key: 'PROJ-44' } },
    { type: { inward: 'IS BLOCKED BY' }, inwardIssue: { key: 'not a Jira key' } },
  ];
  assert.deepEqual(deriveBlockerKeys(issue('PROJ-51', { links })), [
    { key: 'PROJ-42', reason: 'PROJ-51 is blocked by it' },
  ]);
});

test('Jira sync seeds assignment, reconciles a dependency placeholder, and fetches it', async () => {
  const db = openStore(':memory:');
  const calls = [];
  const originalFetch = globalThis.fetch;
  const deriving = issue('PROJ-51', {
    accountId: 'me',
    links: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'PROJ-42' } }],
  });

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      calls.push(url);
      if (url.pathname.endsWith('/myself')) return json({ accountId: 'me' });
      if (url.pathname.endsWith('/search/jql')) {
        const jql = url.searchParams.get('jql');
        return json({ issues: jql.startsWith('key in') ? [] : [deriving] });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    await sync(db, {}, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.filter((url) => url.pathname.endsWith('/myself')).length, 1);
  assert.equal(
    calls.filter((url) => url.pathname.endsWith('/search/jql') && url.searchParams.get('jql').startsWith('key in')).length,
    1
  );
  const blocker = db.prepare(
    'SELECT * FROM objects WHERE connector = ? AND external_id = ?'
  ).get('jira', 'PROJ-42');
  assert.equal(blocker.name, 'PROJ-42 (dependency)');
  assert.equal(blocker.last_snapshot_id, null);
  assert.deepEqual(watchIndex(db).get(blocker.id), {
    source: 'dependency', reason: 'PROJ-51 is blocked by it', weight: 1,
  });
  const assigned = db.prepare(
    'SELECT id FROM objects WHERE connector = ? AND external_id = ?'
  ).get('jira', 'PROJ-51');
  assert.deepEqual(watchIndex(db).get(assigned.id), {
    source: 'assigned', reason: 'assigned to you', weight: 1,
  });
});

test('Jira blocker refetches ingest content without seeding relevance or a second hop', async () => {
  const db = openStore(':memory:');
  const originalFetch = globalThis.fetch;
  const blockerJqls = [];
  const parentWithBlocker = issue('PROJ-51', {
    accountId: 'me',
    links: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'PROJ-42' } }],
  });
  const parentWithoutBlocker = issue('PROJ-51', { accountId: 'me' });
  // The refetched blocker deliberately looks relevant on its own and has a
  // further blocker. Its response must remain content-only.
  const refetchedBlocker = issue('PROJ-42', {
    accountId: 'me',
    links: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'PROJ-43' } }],
  });
  let primary = parentWithBlocker;

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/myself')) return json({ accountId: 'me' });
      if (!url.pathname.endsWith('/search/jql')) throw new Error(`unexpected request: ${url}`);
      const jql = url.searchParams.get('jql');
      if (jql.startsWith('key in')) {
        blockerJqls.push(jql);
        return json({ issues: [refetchedBlocker] });
      }
      return json({ issues: [primary] });
    };

    await sync(db, {}, ENV);

    const blocker = db.prepare(
      'SELECT * FROM objects WHERE connector = ? AND external_id = ?'
    ).get('jira', 'PROJ-42');
    // Its snapshot was refreshed, but no connector-owned relevance fact was
    // created from the blocker-only JQL request.
    assert.notEqual(blocker.last_snapshot_id, null);
    assert.deepEqual(
      db.prepare(
        `SELECT source FROM watches
         WHERE object_id = ? AND source IN ('tracked', 'assigned')
         ORDER BY source`
      ).all(blocker.id).map((row) => ({ ...row })),
      [],
    );
    assert.deepEqual(
      db.prepare(
        `SELECT deriving_key, o.external_id AS blocker_key
         FROM watch_edges e
         JOIN objects o ON o.id = e.blocker_object_id
         ORDER BY deriving_key, blocker_key`
      ).all().map((row) => ({ ...row })),
      [{ deriving_key: 'PROJ-51', blocker_key: 'PROJ-42' }],
    );

    // Re-observing the primary issue without its link removes the sole edge.
    // If blocker observations derived their own links, PROJ-43 would still be
    // returned by dependencyKeys and trigger a second blocker request here.
    primary = parentWithoutBlocker;
    await sync(db, {}, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(blockerJqls, ['key in (PROJ-42)']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM watch_edges').get().count, 0);
});

test('Jira blocker fetch chunks 51 keys and follows nextPageToken pagination', async () => {
  const db = openStore(':memory:');
  const originalFetch = globalThis.fetch;
  const calls = [];
  const deriving = Array.from({ length: 51 }, (_, index) => issue(`TASK-${index + 1}`, {
    links: [{
      type: { inward: 'is blocked by' },
      inwardIssue: { key: `DEP-${index + 1}` },
    }],
  }));

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/myself')) return json({ accountId: 'me' });
      if (!url.pathname.endsWith('/search/jql')) throw new Error(`unexpected request: ${url}`);
      calls.push(url);
      const jql = url.searchParams.get('jql');
      if (!jql.startsWith('key in')) {
        // This proves the main JQL route itself continues through a page
        // token before the one-hop dependency pass begins.
        return url.searchParams.get('nextPageToken')
          ? json({ issues: [] })
          : json({ issues: deriving, nextPageToken: 'main-page-2' });
      }
      // Make the first 50-key batch paginate too; no response results are
      // needed because the placeholders are the behavior under test.
      if (url.searchParams.get('nextPageToken')) return json({ issues: [] });
      const keyCount = jql.slice('key in ('.length, -1).split(',').length;
      return keyCount === 50
        ? json({ issues: [], nextPageToken: 'blocker-page-2' })
        : json({ issues: [] });
    };

    await sync(db, {}, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const mainPages = calls.filter((url) => !url.searchParams.get('jql').startsWith('key in'));
  assert.equal(mainPages.length, 2);
  const blockerCalls = calls.filter((url) => url.searchParams.get('jql').startsWith('key in'));
  const firstPages = blockerCalls.filter((url) => !url.searchParams.get('nextPageToken'));
  assert.equal(firstPages.length, 2);
  assert.deepEqual(
    firstPages.map((url) => url.searchParams.get('jql').slice('key in ('.length, -1).split(',').length).sort((a, b) => a - b),
    [1, 50]
  );
  assert.ok(blockerCalls.some((url) => url.searchParams.get('nextPageToken') === 'blocker-page-2'));
});

test('a failed Jira identity request still seeds the tracked fact', async () => {
  const db = openStore(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/myself')) throw new Error('identity unavailable');
      return json({ issues: [issue('PROJ-7', { accountId: 'me' })] });
    };
    await sync(db, {}, ENV);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const object = db.prepare('SELECT * FROM objects WHERE external_id = ?').get('PROJ-7');
  assert.deepEqual(watchIndex(db).get(object.id), {
    source: 'tracked', reason: null, weight: 1,
  });
});

test('identical Jira observations reseed watch facts without creating snapshots or deltas', async () => {
  const db = openStore(':memory:');
  const originalFetch = globalThis.fetch;
  const raw = issue('PROJ-8', { accountId: 'me' });
  let myselfCalls = 0;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/myself')) {
        myselfCalls += 1;
        return json({ accountId: 'me' });
      }
      return json({ issues: [raw] });
    };
    await sync(db, {}, ENV);
    const object = db.prepare('SELECT * FROM objects WHERE external_id = ?').get('PROJ-8');
    const snapshots = db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count;
    const deltas = db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count;
    clearWatchFact(db, object.id, 'assigned');

    const second = await sync(db, {}, ENV);
    assert.equal(second.changed, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, snapshots);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deltas').get().count, deltas);
    assert.equal(myselfCalls, 2);
    assert.deepEqual(watchIndex(db).get(object.id), {
      source: 'assigned', reason: 'assigned to you', weight: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
