import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ensureObject,
  gc,
  ingestSnapshot,
  markSeen,
  openStore,
  resolveLabeledSnapshot,
  unseenDeltas,
} from '../src/core/store.js';
import {
  captureDiffers,
  captureFile,
  diffLabels,
  replayCapture,
} from '../src/capture.js';
import { toCard } from '../src/core/cards.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'what-changed-capture-'));
}

function writeCapture(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function a11ySnapshot(buttons = []) {
  return [
    '- main:',
    '  - heading "Checkout" [level=1]',
    '  - button "Sign in"',
    ...buttons.map((button) => `  - button "${button}"`),
    '',
  ].join('\n');
}

function openApiSnapshot(extraEndpoint = false) {
  return [
    'openapi: 3.1.0',
    'info:',
    '  title: Tiny API',
    '  version: 1.0.0',
    'paths:',
    '  /ping:',
    '    get:',
    '      summary: Ping',
    '      responses:',
    '        "200": {}',
    ...(extraEndpoint ? [
      '  /widgets:',
      '    post:',
      '      summary: Create widget',
      '      responses:',
      '        "201": {}',
    ] : []),
    '',
  ].join('\n');
}

test('captureFile stores a11y snapshots, reports content deltas, and keeps file provenance', () => {
  const dir = tempDir();
  const db = openStore(':memory:');
  try {
    const beforePath = writeCapture(dir, 'checkout-before.yaml', a11ySnapshot());
    const afterPath = writeCapture(dir, 'checkout-after.yaml', a11ySnapshot(['Pay now']));

    const first = captureFile(db, beforePath, { label: 'build-100', series: 'checkout' });
    const second = captureFile(db, afterPath, { label: 'build-101', series: 'checkout' });

    assert.deepEqual(
      { series: first.series, label: first.label, format: first.format, kind: first.kind, hadPrevious: first.hadPrevious },
      { series: 'checkout', label: 'build-100', format: 'a11y', kind: 'document', hadPrevious: false }
    );
    assert.equal(second.hadPrevious, true);
    assert.ok(
      second.deltas.some((delta) => delta.kind === 'content' && /button "Pay now" added/.test(delta.summary)),
      second.deltas.map((delta) => delta.summary).join(' | ')
    );

    const rows = unseenDeltas(db);
    const created = rows.find((row) => row.kind === 'created');
    const added = rows.find((row) => /button "Pay now" added/.test(row.summary));
    assert.equal(created.provenance_url, resolve(beforePath));
    assert.equal(added.kind, 'content');
    assert.equal(added.provenance_url, resolve(afterPath));
    assert.equal(toCard(added).provenance_url, resolve(afterPath));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diffLabels routes document and data captures and resolves labels by series', () => {
  const dir = tempDir();
  const db = openStore(':memory:');
  try {
    const ui = writeCapture(dir, 'ui.yaml', a11ySnapshot());
    captureFile(db, ui, { label: 'ui-before', series: 'ui' });
    writeFileSync(ui, a11ySnapshot(['Pay now']));
    captureFile(db, ui, { label: 'ui-after', series: 'ui' });

    const documentOps = diffLabels(db, 'ui-before', 'ui-after', { series: 'ui' });
    assert.ok(documentOps.some((op) => /button "Pay now" added/.test(op.summary)), JSON.stringify(documentOps));

    const config = writeCapture(dir, 'config.json', JSON.stringify({ settings: { retries: 3 }, keep: true }));
    captureFile(db, config, { label: 'data-before', series: 'config' });
    writeFileSync(config, JSON.stringify({ settings: { retries: 5 }, keep: true }));
    const dataCapture = captureFile(db, config, { label: 'data-after', series: 'config' });
    assert.deepEqual(
      dataCapture.deltas.map((delta) => ({ kind: delta.kind, path: delta.path, summary: delta.summary })),
      [{ kind: 'field', path: '/content/settings/retries', summary: 'settings.retries: 3 → 5' }]
    );
    const dataOps = diffLabels(db, 'data-before', 'data-after', { series: 'config' });
    assert.equal(dataOps.length, 1);
    assert.equal(dataOps[0].path, '/settings/retries');
    assert.match(dataOps[0].summary, /settings\.retries: 3 → 5/);

    assert.throws(
      () => diffLabels(db, 'ui-before', 'data-before'),
      /belong to different series: ui vs config/
    );
    assert.throws(() => diffLabels(db, 'does-not-exist', 'ui-after', { series: 'ui' }), /not found/);

    captureFile(db, config, { label: 'build-123', series: 'alpha' });
    captureFile(db, config, { label: 'build-123', series: 'beta' });
    assert.throws(
      () => resolveLabeledSnapshot(db, 'build-123'),
      /ambiguous across series: alpha, beta/
    );
    assert.equal(resolveLabeledSnapshot(db, 'build-123', { series: 'beta' }).series, 'beta');
    assert.deepEqual(diffLabels(db, 'build-123', 'build-123', { series: 'beta' }), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('captureFile rejects duplicate labels before writing a second snapshot', () => {
  const dir = tempDir();
  const db = openStore(':memory:');
  try {
    const path = writeCapture(dir, 'state.json', JSON.stringify({ version: 1 }));
    captureFile(db, path, { label: 'build-1', series: 'duplicate-series' });
    const object = db.prepare(
      "SELECT id FROM objects WHERE connector = 'capture' AND external_id = 'duplicate-series'"
    ).get();
    const before = db.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE object_id = ?').get(object.id).count;

    assert.throws(
      () => captureFile(db, path, { label: 'build-1', series: 'duplicate-series' }),
      /label build-1 already exists in series duplicate-series/
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE object_id = ?').get(object.id).count,
      before
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('identical named captures create a new snapshot and labeled non-head payloads survive GC', () => {
  const dir = tempDir();
  const db = openStore(':memory:');
  try {
    const path = writeCapture(dir, 'same.json', JSON.stringify({ feature: 'on' }));
    const first = captureFile(db, path, { label: 'first', series: 'retained' });
    markSeen(db);
    const second = captureFile(db, path, { label: 'second', series: 'retained' });

    assert.equal(second.changed, true);
    assert.deepEqual(second.deltas, []);
    const firstRow = db.prepare('SELECT payload FROM snapshots WHERE id = ?').get(first.snapshotId);
    const head = db.prepare(
      "SELECT last_snapshot_id FROM objects WHERE connector = 'capture' AND external_id = 'retained'"
    ).get();
    assert.notEqual(first.snapshotId, Number(head.last_snapshot_id));
    assert.equal(gc(db, { retainDays: 0 }), 0);
    assert.notEqual(firstRow.payload, null);
    assert.notEqual(db.prepare('SELECT payload FROM snapshots WHERE id = ?').get(first.snapshotId).payload, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replayCapture supports Markdown fallback and YAML OpenAPI captures', () => {
  const dir = tempDir();
  const db = openStore(':memory:');
  try {
    const markdown = writeCapture(dir, 'release.md', '# Release notes\n\n- Shipped\n');
    captureFile(db, markdown, { label: 'notes', series: 'docs' });
    const markdownPayload = JSON.parse(resolveLabeledSnapshot(db, 'notes', { series: 'docs' }).payload);
    assert.equal(markdownPayload.format, 'markdown');
    assert.equal(replayCapture(markdownPayload.content, markdownPayload.format).codec, 'markdown');

    const api = writeCapture(dir, 'api.yaml', openApiSnapshot());
    captureFile(db, api, { label: 'v1', series: 'tiny-api' });
    const apiPayload = JSON.parse(resolveLabeledSnapshot(db, 'v1', { series: 'tiny-api' }).payload);
    assert.equal(apiPayload.format, 'openapi');
    assert.equal(replayCapture(apiPayload.content, apiPayload.format).codec, 'openapi');
    writeFileSync(api, openApiSnapshot(true));
    const changed = captureFile(db, api, { label: 'v2', series: 'tiny-api' });
    assert.ok(changed.deltas.some((delta) => /POST \/widgets added/.test(delta.summary)), changed.deltas.map((d) => d.summary).join(' | '));

    const invalid = writeCapture(dir, 'invalid.txt', 'this is not structured input');
    assert.throws(
      () => captureFile(db, invalid, { label: 'bad', series: 'invalid' }),
      /Could not detect format/
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture differs degrade safely and format changes emit only their dedicated delta', () => {
  const dir = tempDir();
  const db = openStore(':memory:');
  try {
    const corrupted = ensureObject(db, {
      connector: 'capture', externalId: 'corrupted', objectType: 'capture', name: 'corrupted', url: null,
    });
    const first = ingestSnapshot(db, corrupted, { format: 'json', content: '{"version":1}' }, {
      label: 'good', differs: captureDiffers,
    });
    db.prepare('UPDATE snapshots SET payload = ? WHERE id = ?').run(
      JSON.stringify({ format: 'json', content: '{not valid json' }),
      first.snapshotId
    );
    const opaque = ingestSnapshot(db, corrupted, { format: 'json', content: '{"version":2}' }, {
      label: 'bad', differs: captureDiffers,
    });
    assert.deepEqual(opaque.deltas.map((delta) => delta.summary), ['capture content changed']);

    const a11y = writeCapture(dir, 'format.yaml', a11ySnapshot());
    captureFile(db, a11y, { label: 'a11y', series: 'format-change' });
    const json = writeCapture(dir, 'format.json', JSON.stringify({ version: 2 }));
    const changedFormat = captureFile(db, json, { label: 'json', series: 'format-change' });
    assert.deepEqual(
      changedFormat.deltas.map((delta) => ({ kind: delta.kind, summary: delta.summary })),
      [{ kind: 'content', summary: 'capture format changed: a11y → json' }]
    );
    assert.throws(
      () => diffLabels(db, 'a11y', 'json', { series: 'format-change' }),
      /cannot diff capture formats a11y vs json/
    );

    const sameContent = writeCapture(dir, 'same-format.yaml', a11ySnapshot(['Pay now']));
    captureFile(db, sameContent, { label: 'native', series: 'format-only' });
    const forced = captureFile(db, sameContent, { label: 'yaml', series: 'format-only', format: 'yaml' });
    assert.deepEqual(
      forced.deltas.map((delta) => delta.summary),
      ['capture format changed: a11y → yaml']
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture CLI validates labels, lists/filter captures, and wires label diffing', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'captures.db');
    writeFileSync(join(dir, 'what-changed.config.json'), JSON.stringify({ db: dbPath }));
    const file = writeCapture(dir, 'checkout.yaml', a11ySnapshot());

    const missingLabel = runCli(dir, ['capture', file]);
    assert.notEqual(missingLabel.status, 0);
    assert.match(missingLabel.stderr, /capture <file> --label <name>/);

    const first = runCli(dir, ['capture', file, '--label', 'build-1']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /captured checkout\.yaml @ build-1 \(a11y, 3 blocks\)/);
    writeFileSync(file, a11ySnapshot(['Pay now']));
    const second = runCli(dir, ['capture', '--label', 'build-2', file]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /captured checkout\.yaml @ build-2 \(a11y, 4 blocks\)/);
    assert.match(second.stdout, /\d+ deltas recorded\./);
    const report = runCli(dir, ['report']);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /button "Pay now" added/);
    assert.match(report.stdout, new RegExp(resolve(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const explicit = runCli(dir, ['capture', file, '--label', 'app-1', '--series', 'other-app']);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.stdout, /captured other-app @ app-1/);

    const listed = runCli(dir, ['captures']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.indexOf('checkout.yaml @ build-1') < listed.stdout.indexOf('checkout.yaml @ build-2'));
    assert.match(listed.stdout, /other-app @ app-1/);
    const filtered = runCli(dir, ['captures', '--series', 'checkout.yaml']);
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.match(filtered.stdout, /checkout\.yaml @ build-1/);
    assert.doesNotMatch(filtered.stdout, /other-app @ app-1/);

    const labelDiff = runCli(dir, ['diff', '--labels', 'build-1', 'build-2', '--series', 'checkout.yaml']);
    assert.equal(labelDiff.status, 0, labelDiff.stderr);
    assert.match(labelDiff.stdout, /\[ADDED\] button "Pay now" added/);
    const labelDiffJson = runCli(dir, ['diff', '--labels', 'build-1', 'build-2', '--series', 'checkout.yaml', '--json']);
    assert.equal(labelDiffJson.status, 0, labelDiffJson.stderr);
    assert.ok(JSON.parse(labelDiffJson.stdout).some((op) => /button "Pay now" added/.test(op.summary)));

    const firstAmbiguous = runCli(dir, ['capture', file, '--label', 'shared', '--series', 'alpha']);
    const secondAmbiguous = runCli(dir, ['capture', file, '--label', 'shared', '--series', 'beta']);
    assert.equal(firstAmbiguous.status, 0, firstAmbiguous.stderr);
    assert.equal(secondAmbiguous.status, 0, secondAmbiguous.stderr);
    const ambiguous = runCli(dir, ['diff', '--labels', 'shared', 'shared']);
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /ambiguous across series: alpha, beta/);

    const help = runCli(dir, []);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /what-changed capture <file> --label <name>/);
    assert.match(help.stdout, /what-changed captures \[--series <name>\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
