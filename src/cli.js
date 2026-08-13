#!/usr/bin/env node
// what-changed CLI — one of five doors over the same core (FOUNDING.md §9).
// Commands: sync | report | diff | mark-seen | mute | demo
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, unseenDeltas, markSeen, addMute, gc } from './core/store.js';
import { diffFiles } from './diff-files.js';
import { toCard, renderDigest } from './core/cards.js';
import { ingestFixtureFile } from './connectors/fixture.js';
import * as github from './connectors/github.js';
import * as jira from './connectors/jira.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTORS = { github, jira };

function loadConfig() {
  const path = resolve(process.cwd(), 'what-changed.config.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function openConfiguredStore(config) {
  return openStore(resolve(process.cwd(), config?.db ?? 'what-changed.db'));
}

async function cmdSync() {
  const config = loadConfig();
  if (!config) fail('No what-changed.config.json in this directory. See README for the shape.');
  const db = openConfiguredStore(config);
  for (const [name, connector] of Object.entries(CONNECTORS)) {
    if (!config.connectors?.[name]) continue;
    const results = await connector.sync(db, config.connectors[name]);
    console.log(`${name}: ${results.objects} objects checked, ${results.changed} changed`);
  }
  // GC rides along with every sync — the store must not bloat.
  const dropped = gc(db, { retainDays: config.retain_days ?? 30 });
  if (dropped) console.log(`gc: dropped ${dropped} aged snapshot payload${dropped > 1 ? 's' : ''}`);
}

function cmdReport({ json = false, ack = false } = {}) {
  const config = loadConfig();
  const db = openConfiguredStore(config);
  const rows = unseenDeltas(db);
  const cards = rows.map((row) => toCard(row));
  if (json) console.log(JSON.stringify(cards, null, 2));
  else console.log(renderDigest(cards));
  if (ack && rows.length) {
    markSeen(db, rows.map((r) => r.id));
    console.log(`\n(${rows.length} deltas marked seen)`);
  }
}

function cmdMarkSeen() {
  const db = openConfiguredStore(loadConfig());
  markSeen(db);
  console.log('All deltas marked seen. Your baseline is now.');
}

function cmdMute(scope, pattern) {
  if (!['kind', 'path', 'object'].includes(scope) || !pattern) {
    fail('Usage: what-changed mute <kind|path|object> <pattern>');
  }
  const db = openConfiguredStore(loadConfig());
  addMute(db, scope, pattern);
  console.log(`Muted ${scope}: ${pattern}`);
}

function cmdDiffFiles(pathA, pathB, { json = false, format = null } = {}) {
  if (!pathA || !pathB) fail('Usage: what-changed diff <fileA> <fileB> [--json] [--format <id>]');
  const ops = diffFiles(pathA, pathB, format);
  if (json) console.log(JSON.stringify(ops, null, 2));
  else if (!ops.length) console.log('No changes.');
  else for (const op of ops) console.log(`[${op.op.toUpperCase()}] ${op.summary}`);
}

function cmdDemo() {
  // Self-contained: in-memory DB, fixture observations at two points in time.
  const db = openStore(':memory:');
  const fixtures = join(HERE, '..', 'fixtures', 'demo');
  ingestFixtureFile(db, join(fixtures, 'monday.json'));
  markSeen(db); // Monday evening: you looked at everything.
  ingestFixtureFile(db, join(fixtures, 'tuesday.json'));
  console.log('While you slept (Monday baseline → Tuesday morning):\n');
  console.log(renderDigest(unseenDeltas(db).map((row) => toCard(row))));
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'sync': await cmdSync(); break;
  case 'report': cmdReport({ json: rest.includes('--json'), ack: rest.includes('--ack') }); break;
  case 'diff': {
    const fi = rest.indexOf('--format');
    cmdDiffFiles(rest[0], rest[1], { json: rest.includes('--json'), format: fi >= 0 ? rest[fi + 1] : null });
    break;
  }
  case 'mark-seen': cmdMarkSeen(); break;
  case 'mute': cmdMute(rest[0], rest[1]); break;
  case 'gc': {
    const di = rest.indexOf('--days');
    const dropped = gc(openConfiguredStore(loadConfig()), { retainDays: di >= 0 ? Number(rest[di + 1]) : 30 });
    console.log(`Dropped ${dropped} aged snapshot payload${dropped === 1 ? '' : 's'} (hashes and deltas kept).`);
    break;
  }
  case 'demo': cmdDemo(); break;
  default:
    console.log(`what-changed — a local change-memory layer for work tools

Usage:
  what-changed sync                 Pull changes from configured connectors
  what-changed report [--json] [--ack]
                                    Show what changed since you last looked
  what-changed diff <fileA> <fileB> [--json]
                                    Ad-hoc diff of two files (ADF via codec,
                                    plain JSON via structural diff)
  what-changed mark-seen            Reset your baseline to now
  what-changed mute <kind|path|object> <pattern>
                                    Silence a delta kind, path prefix, or object
  what-changed gc [--days N]        Drop aged snapshot payloads (auto-runs on sync)
  what-changed demo                 Self-contained fixture demo (no tokens needed)

Auth is BYOT: GITHUB_TOKEN, JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN.`);
}
