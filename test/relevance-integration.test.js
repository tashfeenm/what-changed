import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ensureObject,
  ingestSnapshot,
  markSeen,
  openStore,
  setWatchEdge,
  unseenDeltas,
  watchIndex,
} from '../src/core/store.js';
import { jiraLens } from '../src/core/lens.js';
import { toCard } from '../src/core/cards.js';
import { ingestFixtureFile } from '../src/connectors/fixture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'what-changed-relevance-cli-'));
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function issue(db, externalId, name = externalId) {
  return ensureObject(db, {
    connector: 'jira',
    externalId,
    objectType: 'issue',
    name,
    url: `https://example.test/browse/${externalId}`,
  });
}

test('fixture relevance applies qualified fact rows and edges, but rejects dependency facts', () => {
  const dir = tempDir();
  const validPath = join(dir, 'valid.json');
  const invalidPath = join(dir, 'invalid.json');
  const db = openStore(':memory:');
  try {
    writeFileSync(validPath, JSON.stringify({
      observations: [
        {
          connector: 'fixture', external_id: 'BLOCK-1', object_type: 'issue',
          name: 'Blocker', url: 'https://example.test/BLOCK-1', payload: { value: 1 },
        },
        {
          connector: 'fixture', external_id: 'MANUAL-1', object_type: 'issue',
          name: 'Manual', url: 'https://example.test/MANUAL-1', payload: { value: 1 },
        },
      ],
      watches: [
        { connector: 'fixture', external_id: 'MANUAL-1', source: 'manual', reason: 'important rollout' },
      ],
      edges: [
        { connector: 'fixture', external_id: 'BLOCK-1', deriving_key: 'WORK-9', reason: 'WORK-9 is blocked by it' },
      ],
    }));
    ingestFixtureFile(db, validPath);

    const blocker = db.prepare(
      'SELECT * FROM objects WHERE connector = ? AND external_id = ?'
    ).get('fixture', 'BLOCK-1');
    const manual = db.prepare(
      'SELECT * FROM objects WHERE connector = ? AND external_id = ?'
    ).get('fixture', 'MANUAL-1');
    assert.deepEqual(watchIndex(db).get(blocker.id), {
      source: 'dependency', reason: 'WORK-9 is blocked by it', weight: 1,
    });
    assert.deepEqual(watchIndex(db).get(manual.id), {
      source: 'manual', reason: 'important rollout', weight: 1,
    });

    writeFileSync(invalidPath, JSON.stringify({
      watches: [{ connector: 'fixture', external_id: 'BLOCK-1', source: 'dependency' }],
    }));
    assert.throws(
      () => ingestFixtureFile(db, invalidPath),
      /dependency.*fixture edges/i,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('change cards keep the exact contract and surface a string relevance reason', () => {
  const card = toCard({
    id: 42,
    object_id: 7,
    object_name: 'PROJ-42 Checkout is blocked',
    external_id: 'PROJ-42',
    connector: 'jira',
    kind: 'comment',
    summary: 'the ticket got a comment overnight',
    provenance_url: 'https://example.test/browse/PROJ-42',
    object_url: null,
    observed_at: '2026-08-13T09:00:00.000Z',
  }, {
    whyIndex: new Map([[7, {
      source: 'dependency', reason: 'PROJ-51 is blocked by it', weight: 1,
    }]]),
  });

  assert.deepEqual(Object.keys(card).sort(), [
    'actions', 'confidence', 'delta_id', 'kind', 'object', 'observed_at',
    'provenance_url', 'source', 'what', 'why_it_matters',
  ]);
  assert.equal(typeof card.what, 'string');
  assert.equal(typeof card.why_it_matters, 'string');
  assert.equal(card.why_it_matters, 'PROJ-51 is blocked by it');
  assert.equal(typeof card.source, 'string');
  assert.equal(typeof card.kind, 'string');
  assert.equal(typeof card.object, 'string');
  assert.equal(typeof card.confidence, 'string');
  assert.equal(typeof card.provenance_url, 'string');
  assert.equal(typeof card.observed_at, 'string');
  assert.equal(typeof card.delta_id, 'number');
  assert.deepEqual(card.actions, ['open', 'mark_seen', 'mute_kind', 'unwatch']);
});

test('demo renders the blocker reason only beneath the dependency object deltas', () => {
  const result = runCli(ROOT, ['demo']);
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout;
  const firstUnrelated = output.indexOf('PROJ-51 Checkout redesign rollout');
  assert.ok(firstUnrelated > 0, output);
  const blockerSection = output.slice(0, firstUnrelated);
  const unrelatedSection = output.slice(firstUnrelated);
  assert.match(blockerSection, /PROJ-42 Payment service rate-limits checkout:[\s\S]*↳ PROJ-51 is blocked by it/);
  assert.doesNotMatch(unrelatedSection, /↳ PROJ-51 is blocked by it/);
});

test('report --only filters by blocker source and kind, and --ack only acknowledges displayed rows', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'store.db');
  const configPath = join(dir, 'what-changed.config.json');
  let db = openStore(dbPath);
  try {
    writeFileSync(configPath, JSON.stringify({ db: dbPath }));
    const blocker = issue(db, 'BLOCK-1', 'BLOCK-1 A production dependency');
    const commenter = issue(db, 'COMMENT-1', 'COMMENT-1 A watched ticket');
    const ordinary = issue(db, 'FIELD-1', 'FIELD-1 An unrelated ticket');

    ingestSnapshot(db, blocker, { status: 'To Do' }, { lens: jiraLens });
    ingestSnapshot(db, commenter, { comment_count: 0 }, { lens: jiraLens });
    ingestSnapshot(db, ordinary, { priority: 'Low' }, { lens: jiraLens });
    markSeen(db);
    ingestSnapshot(db, blocker, { status: 'Blocked' }, { lens: jiraLens });
    ingestSnapshot(db, commenter, { comment_count: 1 }, { lens: jiraLens });
    ingestSnapshot(db, ordinary, { priority: 'High' }, { lens: jiraLens });
    setWatchEdge(db, blocker.id, 'DERIVER-1', 'DERIVER-1 is blocked by it');
    db.close();
    db = null;

    const blockers = runCli(dir, ['report', '--only', 'blockers']);
    assert.equal(blockers.status, 0, blockers.stderr);
    assert.match(blockers.stdout, /BLOCK-1 A production dependency/);
    assert.doesNotMatch(blockers.stdout, /COMMENT-1 A watched ticket|FIELD-1 An unrelated ticket/);

    const comments = runCli(dir, ['report', '--only', 'comment', '--ack']);
    assert.equal(comments.status, 0, comments.stderr);
    assert.match(comments.stdout, /COMMENT-1 A watched ticket/);
    assert.doesNotMatch(comments.stdout, /BLOCK-1 A production dependency|FIELD-1 An unrelated ticket/);
    assert.match(comments.stdout, /\(1 deltas marked seen\)/);

    db = openStore(dbPath);
    const remaining = unseenDeltas(db);
    assert.equal(remaining.length, 2);
    assert.ok(remaining.every((row) => row.kind !== 'comment'));
    db.close();
    db = null;

    const manuallyWatched = runCli(dir, ['watch', 'jira:BLOCK-1', '--reason', 'temporary manual watch']);
    assert.equal(manuallyWatched.status, 0, manuallyWatched.stderr);

    const ignored = runCli(dir, ['unwatch', 'jira:BLOCK-1']);
    assert.equal(ignored.status, 0, ignored.stderr);
    db = openStore(dbPath);
    assert.equal(watchIndex(db).has(blocker.id), false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM watches WHERE object_id = ? AND source = 'ignored'")
        .get(blocker.id).count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM watches WHERE object_id = ? AND source = 'manual'")
        .get(blocker.id).count,
      0,
    );
    db.close();
    db = null;

    const watched = runCli(dir, ['watch', 'jira:BLOCK-1', '--reason', 'needed for launch']);
    assert.equal(watched.status, 0, watched.stderr);
    db = openStore(dbPath);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM watches WHERE object_id = ? AND source = 'ignored'")
        .get(blocker.id).count,
      0,
    );
    assert.equal(
      db.prepare("SELECT reason FROM watches WHERE object_id = ? AND source = 'manual'").get(blocker.id).reason,
      'needed for launch',
    );
    db.close();
    db = null;

    const defaultWatch = runCli(dir, ['watch', 'jira:FIELD-1']);
    assert.equal(defaultWatch.status, 0, defaultWatch.stderr);
    db = openStore(dbPath);
    assert.equal(
      db.prepare("SELECT reason FROM watches WHERE object_id = ? AND source = 'manual'")
        .get(ordinary.id).reason,
      'watched manually',
    );
    db.close();
    db = null;

    const missing = runCli(dir, ['watch', 'jira:DOES-NOT-EXIST']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Cannot watch jira:DOES-NOT-EXIST: object does not exist/);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unwatch vetoes unseen deltas until watch restores them, while mark-seen remains a full reset', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'store.db');
  const configPath = join(dir, 'what-changed.config.json');
  let db = openStore(dbPath);
  try {
    writeFileSync(configPath, JSON.stringify({ db: dbPath }));
    const ignored = issue(db, 'IGNORED-1', 'IGNORED-1 Hidden until watched again');
    const visible = issue(db, 'VISIBLE-1', 'VISIBLE-1 A visible change');

    ingestSnapshot(db, ignored, { status: 'To Do' }, { lens: jiraLens });
    ingestSnapshot(db, visible, { status: 'To Do' }, { lens: jiraLens });
    markSeen(db);
    ingestSnapshot(db, ignored, { status: 'Blocked' }, { lens: jiraLens });
    ingestSnapshot(db, visible, { status: 'In Progress' }, { lens: jiraLens });
    const ignoredDelta = db.prepare(
      'SELECT id FROM deltas WHERE object_id = ? AND seen_at IS NULL'
    ).get(ignored.id);
    const visibleDelta = db.prepare(
      'SELECT id FROM deltas WHERE object_id = ? AND seen_at IS NULL'
    ).get(visible.id);
    db.close();
    db = null;

    const unwatched = runCli(dir, ['unwatch', 'jira:IGNORED-1']);
    assert.equal(unwatched.status, 0, unwatched.stderr);

    db = openStore(dbPath);
    assert.deepEqual(unseenDeltas(db).map((row) => row.id), [visibleDelta.id]);
    assert.equal(
      db.prepare('SELECT seen_at FROM deltas WHERE id = ?').get(ignoredDelta.id).seen_at,
      null,
    );
    db.close();
    db = null;

    const acknowledged = runCli(dir, ['report', '--ack']);
    assert.equal(acknowledged.status, 0, acknowledged.stderr);
    assert.match(acknowledged.stdout, /VISIBLE-1 A visible change/);
    assert.doesNotMatch(acknowledged.stdout, /IGNORED-1 Hidden until watched again/);
    assert.match(acknowledged.stdout, /\(1 deltas marked seen\)/);

    db = openStore(dbPath);
    assert.equal(
      db.prepare('SELECT seen_at FROM deltas WHERE id = ?').get(ignoredDelta.id).seen_at,
      null,
    );
    assert.ok(
      db.prepare('SELECT seen_at FROM deltas WHERE id = ?').get(visibleDelta.id).seen_at,
    );
    assert.deepEqual(unseenDeltas(db), []);
    db.close();
    db = null;

    const watched = runCli(dir, ['watch', 'jira:IGNORED-1']);
    assert.equal(watched.status, 0, watched.stderr);
    db = openStore(dbPath);
    assert.deepEqual(unseenDeltas(db).map((row) => row.id), [ignoredDelta.id]);
    db.close();
    db = null;

    const restoredReport = runCli(dir, ['report']);
    assert.equal(restoredReport.status, 0, restoredReport.stderr);
    assert.match(restoredReport.stdout, /IGNORED-1 Hidden until watched again/);

    // Unlike report --ack, mark-seen intentionally resets every unseen row,
    // including one hidden by a newly restored ignore veto.
    const ignoredAgain = runCli(dir, ['unwatch', 'jira:IGNORED-1']);
    assert.equal(ignoredAgain.status, 0, ignoredAgain.stderr);
    const reset = runCli(dir, ['mark-seen']);
    assert.equal(reset.status, 0, reset.stderr);
    db = openStore(dbPath);
    assert.ok(
      db.prepare('SELECT seen_at FROM deltas WHERE id = ?').get(ignoredDelta.id).seen_at,
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
