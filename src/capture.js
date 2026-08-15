// Captured-mode ingestion: point-in-time files named by a series + label.
// The store keeps raw text and its detected codec so the same series can move
// between formats without baking a codec identity into the object itself.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { read } from 'read-better';
import { blockDiff } from './core/blockdiff.js';
import { jsonDiff } from './core/diff.js';
import {
  ensureObject,
  ingestSnapshot,
  resolveLabeledSnapshot,
} from './core/store.js';

export const CAPTURE_CONNECTOR = 'capture';
export const CAPTURE_OBJECT_TYPE = 'capture';

/**
 * Re-read stored raw capture content using its stored codec.
 *
 * Detection gets the first chance because some codecs (notably a YAML OpenAPI
 * spec) are detected from text but cannot parse that text when forcibly given
 * their codec id. Text-only formats such as Markdown need the inverse path:
 * bare text has no filename hint, so detection fails and forcing the stored
 * codec is what makes replay possible.
 */
export function replayCapture(content, storedFormat) {
  try {
    const detected = read(content);
    if (detected.codec === storedFormat) return detected;
  } catch {
    // The stored codec below is authoritative when raw text cannot be
    // auto-detected (for example Markdown without its original filename).
  }
  return read(content, { format: storedFormat });
}

/**
 * The production differs for captured payloads. `format` deliberately owns
 * cross-codec changes; `content` returns no op in that case, since structural
 * comparison across codecs is not meaningful.
 */
export const captureDiffers = {
  format(before, after) {
    return [{
      op: 'replace',
      path: '/format',
      before,
      after,
      kind: 'content',
      summary: `capture format changed: ${before} → ${after}`,
    }];
  },

  content(before, after, { prevPayload, newPayload } = {}) {
    if (prevPayload?.format !== newPayload?.format) return [];

    try {
      const previous = replayCapture(before, prevPayload?.format);
      const current = replayCapture(after, newPayload?.format);

      if (previous.kind === 'document' && current.kind === 'document') {
        return blockDiff(previous.blocks, current.blocks).map((op) => ({
          op: op.op,
          path: '/content',
          before: op.before ?? null,
          after: op.after ?? null,
          kind: 'content',
          summary: op.summary,
        }));
      }

      if (previous.kind === 'data' && current.kind === 'data') {
        return jsonDiff(previous.value, current.value).map((op) => {
          return {
            ...op,
            path: `/content${op.path}`,
            kind: 'field',
            // The path records that this came from capture content, while
            // the sentence stays focused on the data field (a.b: X → Y).
            summary: defaultSummary(op),
          };
        });
      }
    } catch {
      // A capture may have been written by an older version or manually
      // corrupted after ingestion. Preserve the event rather than breaking a
      // later capture because its predecessor cannot be parsed.
    }

    return [opaqueContentChange()];
  },
};

/**
 * Validate, store, and compare one named file capture.
 *
 * `series` defaults to the basename so repeated captures of a file naturally
 * build one timeline. The absolute path is retained as delta provenance.
 */
export function captureFile(db, filePath, { label, series = null, format = null } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('capture file path must be a non-empty string');
  }

  const absolutePath = resolve(filePath);
  const captureSeries = assertNonEmptyString(series ?? basename(absolutePath), 'series');
  const captureLabel = assertNonEmptyString(label, 'label');

  // Validate before writing. Passing the filename keeps Markdown's explicit
  // extension hint while `format` remains an intentional caller override.
  const content = readFileSync(absolutePath, 'utf8');
  const parsed = read(content, { filename: absolutePath, format });

  assertLabelAvailable(db, captureLabel, captureSeries);

  const object = ensureObject(db, {
    connector: CAPTURE_CONNECTOR,
    externalId: captureSeries,
    objectType: CAPTURE_OBJECT_TYPE,
    name: captureSeries,
    url: null,
  });
  const hadPrevious = Boolean(object.last_snapshot_id);
  const result = ingestSnapshot(
    db,
    object,
    { format: parsed.codec, content },
    {
      label: captureLabel,
      differs: captureDiffers,
      provenanceUrl: absolutePath,
    }
  );

  return {
    series: captureSeries,
    label: captureLabel,
    format: parsed.codec,
    kind: parsed.kind,
    blocks: parsed.kind === 'document' ? parsed.blocks.length : null,
    hadPrevious,
    ...result,
  };
}

/**
 * Compare two stored labels on demand. Ingestion is the only place formats
 * may cross over; an on-demand structural diff deliberately refuses them.
 */
export function diffLabels(db, labelA, labelB, { series = null } = {}) {
  const snapshotA = resolveLabeledSnapshot(db, labelA, { series });
  const snapshotB = resolveLabeledSnapshot(db, labelB, { series });
  const seriesA = snapshotSeries(snapshotA);
  const seriesB = snapshotSeries(snapshotB);

  if (seriesA !== seriesB) {
    throw new Error(`capture labels ${labelA} and ${labelB} belong to different series: ${seriesA} vs ${seriesB}`);
  }

  const payloadA = payloadOf(snapshotA);
  const payloadB = payloadOf(snapshotB);
  if (payloadA.format !== payloadB.format) {
    throw new Error(`cannot diff capture formats ${payloadA.format} vs ${payloadB.format}`);
  }

  const a = replayCapture(payloadA.content, payloadA.format);
  const b = replayCapture(payloadB.content, payloadB.format);
  if (a.kind === 'document' && b.kind === 'document') {
    return blockDiff(a.blocks, b.blocks);
  }
  if (a.kind === 'data' && b.kind === 'data') {
    return jsonDiff(a.value, b.value).map((op) => ({
      ...op,
      summary: `${displayPath(op.path)}: ${shortValue(op.before)} → ${shortValue(op.after)}`,
    }));
  }

  // A codec has one fixed kind, so this means a malformed/legacy stored
  // payload rather than a valid same-format capture pair.
  throw new Error(`cannot diff capture formats ${payloadA.format} vs ${payloadB.format}`);
}

function assertLabelAvailable(db, label, series) {
  try {
    resolveLabeledSnapshot(db, label, { series });
  } catch (error) {
    if (/not found/i.test(String(error?.message))) return;
    throw error;
  }
  throw new Error(`label ${label} already exists in series ${series}`);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    // Keep captureFile's early validation aligned with the store resolver.
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function snapshotSeries(snapshot) {
  // `series` is the store helper's public alias; external_id keeps this
  // module tolerant of old stores queried directly during an upgrade.
  return snapshot.series ?? snapshot.external_id;
}

function payloadOf(snapshot) {
  if (snapshot?.payload === null || snapshot?.payload === undefined) {
    throw new Error(`capture payload for label ${snapshot?.label ?? '(unknown)'} is unavailable`);
  }
  const payload = typeof snapshot.payload === 'string'
    ? JSON.parse(snapshot.payload)
    : snapshot.payload;
  if (!payload || typeof payload.format !== 'string' || typeof payload.content !== 'string') {
    throw new Error(`capture payload for label ${snapshot.label ?? '(unknown)'} is invalid`);
  }
  return payload;
}

function opaqueContentChange() {
  return {
    op: 'replace',
    path: '/content',
    before: null,
    after: null,
    kind: 'content',
    summary: 'capture content changed',
  };
}

// Mirrors the store's default summary style for a custom field's JSON ops.
function defaultSummary(op) {
  const field = displayPath(op.path);
  if (op.op === 'add') return `${field} added: ${shortValue(op.after)}`;
  if (op.op === 'remove') return `${field} removed (was ${shortValue(op.before)})`;
  return `${field}: ${shortValue(op.before)} → ${shortValue(op.after)}`;
}

function displayPath(path) {
  return path.split('/').filter(Boolean).join('.') || 'value';
}

function shortValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text == null ? 'null' : text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
