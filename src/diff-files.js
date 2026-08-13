// Ad-hoc diff of two files — the generic "what changed between A and B"
// checker. Detection and parsing are read-better's job; routing is ours:
// document formats → blockDiff, data formats → structural jsonDiff (outlines
// discard values, so block-diffing data would mask changes).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { read } from 'read-better';
import { blockDiff } from './core/blockdiff.js';
import { jsonDiff } from './core/diff.js';

export function diffFiles(pathA, pathB, format = null) {
  const a = read(readFileSync(resolve(pathA), 'utf8'), { filename: pathA, format });
  const b = read(readFileSync(resolve(pathB), 'utf8'), { filename: pathB, format });
  if (a.codec !== b.codec) {
    throw new Error(`Refusing to diff across formats: ${pathA} is ${a.codec}, ${pathB} is ${b.codec}. Pass --format to force one.`);
  }
  if (a.kind === 'document') {
    return blockDiff(a.blocks, b.blocks);
  }
  return jsonDiff(a.value, b.value).map((op) => ({
    ...op,
    summary: `${op.path.split('/').filter(Boolean).join('.') || 'value'}: ${fmt(op.before)} → ${fmt(op.after)}`,
  }));
}

function fmt(v) {
  const s = v === null || v === undefined ? 'null' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
