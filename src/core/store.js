// Snapshot store: SQLite, content-addressed. Plain files/APIs are ground truth;
// this store is disposable and rebuildable. Schema mirrors FOUNDING.md §6.
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, sha256, jsonDiff } from './diff.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  id INTEGER PRIMARY KEY,
  connector TEXT NOT NULL,
  external_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  name TEXT,
  url TEXT,
  last_snapshot_id INTEGER,
  watch_weight REAL NOT NULL DEFAULT 1.0,
  UNIQUE (connector, external_id)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id),
  taken_at TEXT NOT NULL,
  label TEXT,
  payload_hash TEXT NOT NULL,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS deltas (
  id INTEGER PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id),
  from_snapshot INTEGER REFERENCES snapshots(id),
  to_snapshot INTEGER NOT NULL REFERENCES snapshots(id),
  observed_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  before TEXT,
  after TEXT,
  summary TEXT NOT NULL,
  provenance_url TEXT,
  seen_at TEXT
);
CREATE TABLE IF NOT EXISTS cursors (
  connector TEXT NOT NULL,
  scope TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connector, scope)
);
CREATE TABLE IF NOT EXISTS watchlist (
  object_id INTEGER PRIMARY KEY REFERENCES objects(id),
  source TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mutes (
  scope TEXT NOT NULL,      -- 'kind' | 'path' | 'object'
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, pattern)
);
CREATE INDEX IF NOT EXISTS idx_deltas_unseen ON deltas(seen_at) WHERE seen_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_snapshots_object ON snapshots(object_id, taken_at);
`;

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function now() {
  return new Date().toISOString();
}

export function ensureObject(db, { connector, externalId, objectType, name, url }) {
  db.prepare(
    `INSERT INTO objects (connector, external_id, object_type, name, url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (connector, external_id) DO UPDATE SET name = excluded.name, url = excluded.url`
  ).run(connector, externalId, objectType, name ?? null, url ?? null);
  return db
    .prepare('SELECT * FROM objects WHERE connector = ? AND external_id = ?')
    .get(connector, externalId);
}

/**
 * Ingest a new observation of an object. Content-addressed: identical payloads
 * are a no-op. Otherwise stores the snapshot, diffs against the previous one,
 * applies the lens, and records deltas.
 * Returns { changed, snapshotId, deltas }.
 */
export function ingestSnapshot(db, object, payload, { label = null, lens = null, provenanceUrl = null } = {}) {
  const canonical = canonicalize(payload);
  const hash = sha256(canonical);
  // Re-read the head pointer: the caller's object row may be stale.
  const head = db.prepare('SELECT last_snapshot_id FROM objects WHERE id = ?').get(object.id);
  const prev = head?.last_snapshot_id
    ? db.prepare('SELECT * FROM snapshots WHERE id = ?').get(head.last_snapshot_id)
    : null;

  if (prev && prev.payload_hash === hash && !label) {
    return { changed: false, snapshotId: prev.id, deltas: [] };
  }

  const snap = db
    .prepare('INSERT INTO snapshots (object_id, taken_at, label, payload_hash, payload) VALUES (?, ?, ?, ?, ?)')
    .run(object.id, now(), label, hash, canonical);
  const snapshotId = Number(snap.lastInsertRowid);
  db.prepare('UPDATE objects SET last_snapshot_id = ? WHERE id = ?').run(snapshotId, object.id);

  const deltas = [];
  if (prev && prev.payload_hash !== hash) {
    const ops = jsonDiff(JSON.parse(prev.payload), payload);
    const insert = db.prepare(
      `INSERT INTO deltas (object_id, from_snapshot, to_snapshot, observed_at, kind, path, before, after, summary, provenance_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const op of ops) {
      const semantic = lens ? lens(op, payload) : null;
      if (semantic?.suppress) continue; // lens says: bookkeeping, not news
      const kind = semantic?.kind ?? 'field';
      const summary = semantic?.summary ?? defaultSummary(op);
      const url = semantic?.provenanceUrl ?? provenanceUrl ?? object.url;
      insert.run(
        object.id, prev.id, snapshotId, now(), kind, op.path,
        jsonOrNull(op.before), jsonOrNull(op.after), summary, url ?? null
      );
      deltas.push({ objectId: object.id, kind, path: op.path, summary, provenanceUrl: url });
    }
  } else if (!prev) {
    // First sighting: record a single 'created' delta so "what's new" includes new objects.
    db.prepare(
      `INSERT INTO deltas (object_id, from_snapshot, to_snapshot, observed_at, kind, path, before, after, summary, provenance_url)
       VALUES (?, NULL, ?, ?, 'created', '/', NULL, NULL, ?, ?)`
    ).run(object.id, snapshotId, now(), `now tracking: ${object.name ?? object.external_id}`, object.url ?? null);
  }

  return { changed: true, snapshotId, deltas };
}

function defaultSummary(op) {
  const field = op.path.split('/').filter(Boolean).join('.') || 'value';
  if (op.op === 'add') return `${field} added: ${short(op.after)}`;
  if (op.op === 'remove') return `${field} removed (was ${short(op.before)})`;
  return `${field}: ${short(op.before)} → ${short(op.after)}`;
}

function short(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? 'null' : s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function jsonOrNull(v) {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

export function getCursor(db, connector, scope) {
  return db.prepare('SELECT cursor_value FROM cursors WHERE connector = ? AND scope = ?').get(connector, scope)
    ?.cursor_value ?? null;
}

export function setCursor(db, connector, scope, value) {
  db.prepare(
    `INSERT INTO cursors (connector, scope, cursor_value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (connector, scope) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at`
  ).run(connector, scope, value, now());
}

/** Unseen deltas joined with their objects, mutes applied. Newest last. */
export function unseenDeltas(db) {
  const mutes = db.prepare('SELECT scope, pattern FROM mutes').all();
  const rows = db
    .prepare(
      `SELECT d.*, o.connector, o.external_id, o.object_type, o.name AS object_name, o.url AS object_url
       FROM deltas d JOIN objects o ON o.id = d.object_id
       WHERE d.seen_at IS NULL ORDER BY d.observed_at, d.id`
    )
    .all();
  return rows.filter((row) =>
    !mutes.some(
      (m) =>
        (m.scope === 'kind' && row.kind === m.pattern) ||
        (m.scope === 'path' && row.path.startsWith(m.pattern)) ||
        (m.scope === 'object' && `${row.connector}:${row.external_id}` === m.pattern)
    )
  );
}

/** seen ≠ synced: only an explicit acknowledgement sets seen_at. */
export function markSeen(db, deltaIds = null) {
  if (deltaIds === null) {
    db.prepare('UPDATE deltas SET seen_at = ? WHERE seen_at IS NULL').run(now());
    return;
  }
  const stmt = db.prepare('UPDATE deltas SET seen_at = ? WHERE id = ?');
  for (const id of deltaIds) stmt.run(now(), id);
}

export function addMute(db, scope, pattern) {
  db.prepare('INSERT OR IGNORE INTO mutes (scope, pattern, created_at) VALUES (?, ?, ?)').run(scope, pattern, now());
}

export function snapshotByLabel(db, label) {
  return db.prepare('SELECT * FROM snapshots WHERE label = ? ORDER BY id DESC').get(label) ?? null;
}
