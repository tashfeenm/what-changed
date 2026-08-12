// Generic structural JSON diff — the day-one layer every connector gets free.
// Semantic meaning is layered on by lenses (lens.js), never encoded here.
import { createHash } from 'node:crypto';

/** Deterministic JSON serialization: object keys sorted at every level. */
export function canonicalize(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Keys that identify an element inside an array of objects, in preference order.
const IDENTITY_KEYS = ['id', 'key', 'external_id', 'number', 'name'];

/**
 * Diff two JSON values into flat ops: {op: 'add'|'remove'|'replace', path, before, after}.
 * Arrays of identifiable objects are diffed by identity (stable under reorder);
 * everything else falls back to positional comparison.
 */
export function jsonDiff(a, b, path = '') {
  if (deepEqual(a, b)) return [];

  if (Array.isArray(a) && Array.isArray(b)) {
    const idKey = arrayIdentityKey(a) ?? arrayIdentityKey(b);
    if (idKey) return diffArrayById(a, b, idKey, path);
    return diffArrayByIndex(a, b, path);
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const ops = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const childPath = `${path}/${escapeSegment(key)}`;
      if (!(key in b)) ops.push({ op: 'remove', path: childPath, before: a[key], after: null });
      else if (!(key in a)) ops.push({ op: 'add', path: childPath, before: null, after: b[key] });
      else ops.push(...jsonDiff(a[key], b[key], childPath));
    }
    return ops;
  }

  return [{ op: 'replace', path: path || '/', before: a, after: b }];
}

function diffArrayById(a, b, idKey, path) {
  const ops = [];
  const aById = new Map(a.map((el) => [el?.[idKey], el]));
  const bById = new Map(b.map((el) => [el?.[idKey], el]));
  for (const [id, el] of aById) {
    const childPath = `${path}/${escapeSegment(String(id))}`;
    if (!bById.has(id)) ops.push({ op: 'remove', path: childPath, before: el, after: null });
    else ops.push(...jsonDiff(el, bById.get(id), childPath));
  }
  for (const [id, el] of bById) {
    if (!aById.has(id)) {
      ops.push({ op: 'add', path: `${path}/${escapeSegment(String(id))}`, before: null, after: el });
    }
  }
  return ops;
}

function diffArrayByIndex(a, b, path) {
  const ops = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const childPath = `${path}/${i}`;
    if (i >= b.length) ops.push({ op: 'remove', path: childPath, before: a[i], after: null });
    else if (i >= a.length) ops.push({ op: 'add', path: childPath, before: null, after: b[i] });
    else ops.push(...jsonDiff(a[i], b[i], childPath));
  }
  return ops;
}

function arrayIdentityKey(arr) {
  if (!arr.length || !arr.every(isPlainObject)) return null;
  return IDENTITY_KEYS.find((k) => arr.every((el) => el[k] !== undefined && el[k] !== null)) ?? null;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  return canonicalize(a) === canonicalize(b);
}

// JSON Pointer segment escaping (RFC 6901).
function escapeSegment(segment) {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
