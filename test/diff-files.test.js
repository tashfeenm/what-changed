// End-to-end + adversarial tests for the ad-hoc diff checker (Codex
// verification list: mixed formats, native-id edits, meta-only changes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { diffFiles } from '../src/diff-files.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fx = (name) => join(FIXTURES, name);

test('markdown pair: block-level ops', () => {
  const summaries = diffFiles(fx('notes-v1.md'), fx('notes-v2.md')).map((op) => op.summary);
  assert.ok(summaries.some((s) => /quote .*removed|WARNING.*removed/i.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /code block \(bash\) edited/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /task list: 2\/3 done \(was 1\)/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /table: 2 → 3 rows/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /section "Comms" added/.test(s)), summaries.join(' | '));
});

test('figma pair: native-id text edit surfaces as changed, new node as added', () => {
  const ops = diffFiles(fx('figma-file-v1.json'), fx('figma-file-v2.json'));
  const changed = ops.find((op) => op.op === 'changed' && /Title/.test(op.label));
  assert.ok(changed, JSON.stringify(ops));
  assert.equal(changed.before, 'Checkout');
  assert.equal(changed.after, 'Secure Checkout');
  assert.ok(ops.some((op) => op.op === 'added' && /TrustBadge/.test(op.label)));
  // The frame gained a child → same id, meta children 3→4 → changed
  assert.ok(ops.some((op) => op.op === 'changed' && /Checkout \/ Desktop/.test(op.label) && /children: 3 → 4/.test(op.summary)), JSON.stringify(ops.map((o) => o.summary)));
});

test('openapi pair: meta-only param change + endpoint add/remove', () => {
  const ops = diffFiles(fx('openapi-v1.json'), fx('openapi-v2.json'));
  const summaries = ops.map((op) => op.summary);
  assert.ok(summaries.some((s) => /GET \/users: params role\(query,required\) added/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /POST \/orders\/\{id\}\/refund.*added/.test(s)), summaries.join(' | '));
  assert.ok(summaries.some((s) => /GET \/orders\/\{id\}.*removed/.test(s)), summaries.join(' | '));
});

test('data formats route to structural jsonDiff, not blockDiff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ config: { retries: 3 }, arr: [1, 2] }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ config: { retries: 5 }, arr: [1, 2] }));
  const ops = diffFiles(join(dir, 'a.json'), join(dir, 'b.json'));
  assert.equal(ops.length, 1);
  assert.match(ops[0].summary, /config\.retries: 3 → 5/);
});

test('mixed formats refuse loudly', () => {
  assert.throws(
    () => diffFiles(fx('notes-v1.md'), fx('openapi-v1.json')),
    /Refusing to diff across formats/
  );
});

test('yaml data pair diffs by value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-'));
  writeFileSync(join(dir, 'a.yaml'), 'replicas: 2\nregion: us-east-1\n');
  writeFileSync(join(dir, 'b.yaml'), 'replicas: 4\nregion: us-east-1\n');
  const ops = diffFiles(join(dir, 'a.yaml'), join(dir, 'b.yaml'));
  assert.equal(ops.length, 1);
  assert.match(ops[0].summary, /replicas: 2 → 4/);
});
