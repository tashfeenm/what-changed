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
-- watchlist is the legacy, single-winner representation. Keep it for
-- existing stores, but write new relevance information as independent facts.
CREATE TABLE IF NOT EXISTS watches (
  object_id INTEGER NOT NULL REFERENCES objects(id),
  source TEXT NOT NULL,
  reason TEXT,
  weight REAL NOT NULL DEFAULT 1.0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_id, source)
);
-- Dependency facts are edges, rather than rows in watches: several observed
-- issues may independently make the same blocker relevant.
CREATE TABLE IF NOT EXISTS watch_edges (
  blocker_object_id INTEGER NOT NULL REFERENCES objects(id),
  deriving_key TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (blocker_object_id, deriving_key)
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

const SNAPSHOT_LABEL_UNIQUE_INDEX = 'idx_snapshots_object_label_unique';

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrateSnapshotLabelUniqueness(db);
  return db;
}

/**
 * Older stores allowed duplicate labels on an object. Repair them before
 * installing the partial unique index so an upgrade can never be blocked by
 * historical data. The earliest snapshot keeps its label; later rows receive
 * a deterministic, collision-safe suffix.
 */
function migrateSnapshotLabelUniqueness(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicateGroups = db.prepare(
      `SELECT object_id, label
       FROM snapshots
       WHERE label IS NOT NULL
       GROUP BY object_id, label
       HAVING COUNT(*) > 1
       ORDER BY object_id, label`
    ).all();
    const snapshotsForLabel = db.prepare(
      'SELECT id FROM snapshots WHERE object_id = ? AND label = ? ORDER BY id ASC'
    );
    const labelExists = db.prepare(
      'SELECT 1 FROM snapshots WHERE object_id = ? AND label = ? LIMIT 1'
    );
    const renameSnapshot = db.prepare('UPDATE snapshots SET label = ? WHERE id = ?');

    for (const group of duplicateGroups) {
      const duplicates = snapshotsForLabel.all(group.object_id, group.label);
      // Keep the first snapshot's label, matching the pre-unique-index order.
      for (const snapshot of duplicates.slice(1)) {
        let replacement = `${group.label}~${snapshot.id}`;
        while (labelExists.get(group.object_id, replacement)) {
          replacement = `${replacement}~${snapshot.id}`;
        }
        renameSnapshot.run(replacement, snapshot.id);
      }
    }

    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${SNAPSHOT_LABEL_UNIQUE_INDEX}
       ON snapshots(object_id, label)
       WHERE label IS NOT NULL`
    );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the migration failure if rollback cannot run.
    }
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

// Reconciliation can write several edges in one millisecond. Keep timestamps
// strictly ordered per blocker so its newest deriving edge remains knowable,
// including after reopening a persisted database.
function nextEdgeUpdatedAt(db, blockerObjectId) {
  const latest = db.prepare(
    'SELECT MAX(updated_at) AS updated_at FROM watch_edges WHERE blocker_object_id = ?'
  ).get(blockerObjectId)?.updated_at;
  const latestMs = Date.parse(latest ?? '') || 0;
  return new Date(Math.max(Date.now(), latestMs + 1)).toISOString();
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
 * Record one independently-derived relevance fact. Dependency relevance is
 * deliberately represented by watch_edges instead; a single fact row could
 * not retain more than one issue's reason for watching the same blocker.
 */
export function setWatchFact(db, objectId, source, { reason = null, weight = 1.0 } = {}) {
  if (source === 'dependency') {
    throw new Error('dependency watch facts must use watch_edges');
  }
  return db.prepare(
    `INSERT INTO watches (object_id, source, reason, weight, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (object_id, source) DO UPDATE SET
       reason = excluded.reason,
       weight = excluded.weight,
       updated_at = excluded.updated_at`
  ).run(objectId, source, reason, weight ?? 1.0, now());
}

/** Remove one independently-derived relevance fact, if it exists. */
export function clearWatchFact(db, objectId, source) {
  return db.prepare('DELETE FROM watches WHERE object_id = ? AND source = ?').run(objectId, source);
}

/**
 * Clear a source's facts for a set of objects. An empty observation set is a
 * no-op so connector reconciliation can call this without a special case.
 */
export function clearWatchFactsBySource(db, source, objectIds) {
  const ids = [...new Set(objectIds ?? [])];
  if (ids.length === 0) return { changes: 0 };
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(
    `DELETE FROM watches WHERE source = ? AND object_id IN (${placeholders})`
  ).run(source, ...ids);
}

/** Insert or refresh one dependency edge. */
export function setWatchEdge(db, blockerObjectId, derivingKey, reason = null) {
  return db.prepare(
    `INSERT INTO watch_edges (blocker_object_id, deriving_key, reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (blocker_object_id, deriving_key) DO UPDATE SET
       reason = excluded.reason,
       updated_at = excluded.updated_at`
  ).run(blockerObjectId, derivingKey, reason, nextEdgeUpdatedAt(db, blockerObjectId));
}

/**
 * Replace every dependency edge derived from one observed issue. Each entry
 * is { blockerObjectId, reason }; objectId is accepted as a small convenience
 * for callers that already use that spelling.
 */
export function reconcileWatchEdges(db, derivingKey, edges) {
  // Validate the entire replacement before touching the current derivation.
  // This makes malformed input a true no-op instead of dropping its old edges.
  const replacements = [...(edges ?? [])].map((edge) => {
    const blockerObjectId = edge?.blockerObjectId ?? edge?.objectId;
    if (!Number.isInteger(blockerObjectId)) {
      throw new Error('watch edge blockerObjectId must be an integer');
    }
    const reason = edge?.reason ?? null;
    if (reason !== null && typeof reason !== 'string') {
      throw new Error('watch edge reason must be a string or null');
    }
    return { blockerObjectId, reason };
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM watch_edges WHERE deriving_key = ?').run(derivingKey);
    for (const edge of replacements) {
      setWatchEdge(db, edge.blockerObjectId, derivingKey, edge.reason);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the reconciliation failure if rollback cannot run.
    }
    throw error;
  }
}

// A descriptive alias for integrations that call this operation "replace".
export const replaceWatchEdges = reconcileWatchEdges;

const WATCH_PRIORITY = new Map([
  ['tracked', 1],
  ['manual', 2],
  ['assigned', 3],
  ['dependency', 4],
  ['ignored', 5],
]);

/**
 * Resolve fact rows into the effective relevance state at read time. Ignored
 * is a veto, while dependency reasons come from the freshest deriving edge.
 */
export function watchIndex(db) {
  const ignored = new Set();
  const winners = new Map();
  const facts = db.prepare('SELECT object_id, source, reason, weight FROM watches').all();

  for (const fact of facts) {
    if (fact.source === 'ignored') {
      ignored.add(fact.object_id);
      continue;
    }
    const priority = WATCH_PRIORITY.get(fact.source) ?? 0;
    if (priority === 0) continue;
    const current = winners.get(fact.object_id);
    if (!current || priority > current.priority) {
      winners.set(fact.object_id, {
        priority,
        source: fact.source,
        // A tracked row conveys relevance, but its generic reason is noise.
        reason: fact.source === 'tracked' ? null : fact.reason,
        weight: Number(fact.weight),
      });
    }
  }

  // Stable secondary ordering gives a deterministic answer if two edge writes
  // happened in the same clock tick. The primary ordering is updated_at.
  const edges = db.prepare(
    `SELECT blocker_object_id, reason, updated_at
     FROM watch_edges
     ORDER BY updated_at DESC, rowid DESC`
  ).all();
  for (const edge of edges) {
    if (ignored.has(edge.blocker_object_id)) continue;
    const priority = WATCH_PRIORITY.get('dependency');
    const current = winners.get(edge.blocker_object_id);
    if (!current || priority > current.priority) {
      winners.set(edge.blocker_object_id, {
        priority,
        source: 'dependency',
        reason: edge.reason,
        weight: 1.0,
      });
    }
  }

  for (const objectId of ignored) winners.delete(objectId);

  return new Map([...winners].map(([objectId, fact]) => [objectId, {
    source: fact.source,
    reason: fact.reason,
    weight: fact.weight,
  }]));
}

/**
 * Ingest a new observation of an object. Content-addressed: identical payloads
 * are a no-op. Otherwise stores the snapshot, diffs against the previous one,
 * applies the lens, and records deltas.
 * Returns { changed, snapshotId, deltas }.
 */
export function ingestSnapshot(db, object, payload, { label = null, lens = null, differs = null, provenanceUrl = null } = {}) {
  const canonical = canonicalize(payload);
  const hash = sha256(canonical);
  // Re-read the head pointer: the caller's object row may be stale.
  const initialHead = db.prepare('SELECT last_snapshot_id FROM objects WHERE id = ?').get(object.id);
  const initialPrev = initialHead?.last_snapshot_id
    ? db.prepare('SELECT * FROM snapshots WHERE id = ?').get(initialHead.last_snapshot_id)
    : null;

  if (initialPrev && initialPrev.payload_hash === hash && !label) {
    return { changed: false, snapshotId: initialPrev.id, deltas: [] };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // The head can advance between the no-op fast path and the write lock.
    const head = db.prepare('SELECT last_snapshot_id FROM objects WHERE id = ?').get(object.id);
    const prev = head?.last_snapshot_id
      ? db.prepare('SELECT * FROM snapshots WHERE id = ?').get(head.last_snapshot_id)
      : null;

    if (prev && prev.payload_hash === hash && !label) {
      db.exec('COMMIT');
      return { changed: false, snapshotId: prev.id, deltas: [] };
    }

    const snap = db
      .prepare('INSERT INTO snapshots (object_id, taken_at, label, payload_hash, payload) VALUES (?, ?, ?, ?, ?)')
      .run(object.id, now(), label, hash, canonical);
    const snapshotId = Number(snap.lastInsertRowid);
    db.prepare('UPDATE objects SET last_snapshot_id = ? WHERE id = ?').run(snapshotId, object.id);

    const deltas = [];
    if (prev && prev.payload_hash !== hash) {
      const ops = computeOps(JSON.parse(prev.payload), payload, differs);
      const insert = db.prepare(
        `INSERT INTO deltas (object_id, from_snapshot, to_snapshot, observed_at, kind, path, before, after, summary, provenance_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const op of ops) {
        // Ops from a custom differ arrive pre-lensed (kind + summary set).
        const semantic = op.kind ? op : lens ? lens(op, payload) : null;
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
      ).run(
        object.id,
        snapshotId,
        now(),
        `now tracking: ${object.name ?? object.external_id}`,
        provenanceUrl ?? object.url ?? null
      );
    }

    db.exec('COMMIT');
    return { changed: true, snapshotId, deltas };
  } catch (error) {
    const duplicateLabel =
      object.connector === 'capture' &&
      label !== null &&
      isSnapshotLabelConstraint(error);
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the ingest failure if rollback cannot run.
    }
    if (duplicateLabel) {
      throw new Error(`label ${label} already exists in series ${object.external_id}`);
    }
    throw error;
  }
}

/**
 * Generic structural diff, with per-field custom differs. A differ owns one
 * top-level field: (before, after, { prevPayload, newPayload }) => ops with
 * kind + summary already set. The third argument is additive, so existing
 * two-argument differs continue to work unchanged.
 * Rich formats (ADF documents, node trees) need format-aware diffing — the
 * generic diff would see an edited block as remove+add.
 */
function computeOps(prevPayload, newPayload, differs) {
  if (!differs) return jsonDiff(prevPayload, newPayload);
  const prevRest = { ...prevPayload };
  const newRest = { ...newPayload };
  const ops = [];
  for (const [field, differ] of Object.entries(differs)) {
    const before = prevRest[field];
    const after = newRest[field];
    delete prevRest[field];
    delete newRest[field];
    if (canonicalize(before ?? null) !== canonicalize(after ?? null)) {
      ops.push(...differ(before, after, { prevPayload, newPayload }));
    }
  }
  return [...jsonDiff(prevRest, newRest), ...ops];
}

function isSnapshotLabelConstraint(error) {
  return /UNIQUE constraint failed: snapshots\.object_id, snapshots\.label/.test(error?.message ?? '');
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

/** Unseen deltas joined with their objects, mutes and ignored-watch vetoes applied. Newest last. */
export function unseenDeltas(db) {
  const mutes = db.prepare('SELECT scope, pattern FROM mutes').all();
  const rows = db
    .prepare(
      `SELECT d.*, o.connector, o.external_id, o.object_type, o.name AS object_name, o.url AS object_url
       FROM deltas d JOIN objects o ON o.id = d.object_id
       WHERE d.seen_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM watches w
           WHERE w.object_id = d.object_id AND w.source = 'ignored'
         )
       ORDER BY d.observed_at, d.id`
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

/**
 * Resolve a labeled captured snapshot. Labels assigned by tracked connectors
 * intentionally stay outside captured-mode lookup, even when they have the
 * same text.
 */
export function resolveLabeledSnapshot(db, label, { series = null } = {}) {
  validateCaptureLabel(label);
  validateCaptureSeries(series);

  const clauses = ["o.connector = 'capture'", 's.label = ?'];
  const params = [label];
  if (series !== null) {
    clauses.push('o.external_id = ?');
    params.push(series);
  }
  const rows = db.prepare(
    `SELECT s.*, o.external_id AS series
     FROM snapshots s
     JOIN objects o ON o.id = s.object_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY o.external_id ASC, s.id ASC`
  ).all(...params);

  if (rows.length === 0) {
    throw new Error(
      series === null
        ? `capture label ${label} not found`
        : `capture label ${label} not found in series ${series}`
    );
  }
  if (series === null && rows.length > 1) {
    throw new Error(
      `capture label ${label} is ambiguous across series: ${rows.map((row) => row.series).join(', ')}`
    );
  }
  return rows[0];
}

/** List every labeled capture, oldest first (and deterministically by ID). */
export function labeledSnapshots(db, { series = null } = {}) {
  validateCaptureSeries(series);
  const clauses = ["o.connector = 'capture'", 's.label IS NOT NULL'];
  const params = [];
  if (series !== null) {
    clauses.push('o.external_id = ?');
    params.push(series);
  }
  const rows = db.prepare(
    `SELECT o.external_id AS series, s.label, s.taken_at, s.payload
     FROM snapshots s
     JOIN objects o ON o.id = s.object_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY s.taken_at ASC, s.id ASC`
  ).all(...params);
  return rows.map(({ series: snapshotSeries, label, taken_at, payload }) => ({
    series: snapshotSeries,
    label,
    taken_at,
    format: storedFormat(payload),
  }));
}

function validateCaptureLabel(label) {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('label must not be empty');
  }
}

function validateCaptureSeries(series) {
  if (series !== null && (typeof series !== 'string' || series.trim() === '')) {
    throw new Error('series must not be empty');
  }
}

function storedFormat(payload) {
  try {
    return JSON.parse(payload ?? 'null')?.format ?? null;
  } catch {
    return null;
  }
}

/**
 * Garbage collection — the store must not bloat (a11y trees and Figma files
 * are large). Drops RAW PAYLOADS (keeping payload_hash and all computed
 * deltas) from snapshots that are:
 *   - not any object's current head (needed for the next diff),
 *   - not labeled (captured-mode snapshots stay addressable by label),
 *   - older than the retention window, and
 *   - not referenced by any UNSEEN delta (unseen before/after context stays
 *     rehydratable until acknowledged).
 * Returns the number of payloads dropped.
 */
export function gc(db, { retainDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    `UPDATE snapshots SET payload = NULL
     WHERE payload IS NOT NULL
       AND label IS NULL
       AND taken_at < ?
       AND id NOT IN (SELECT last_snapshot_id FROM objects WHERE last_snapshot_id IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM deltas d
         WHERE (d.from_snapshot = snapshots.id OR d.to_snapshot = snapshots.id)
           AND d.seen_at IS NULL
       )`
  ).run(cutoff);
  return Number(result.changes);
}
