#!/usr/bin/env node
// what-changed CLI — one of the doors over the same core (FOUNDING.md §9).
// Commands: sync | report | diff | mark-seen | mute | watch | unwatch | demo
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openStore,
  unseenDeltas,
  markSeen,
  addMute,
  clearWatchFact,
  gc,
  setWatchFact,
  watchIndex,
} from './core/store.js';
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

function cmdReport({ json = false, ack = false, only = null } = {}) {
  const config = loadConfig();
  const db = openConfiguredStore(config);
  const whyIndex = watchIndex(db);
  const rows = filterRows(unseenDeltas(db), whyIndex, only);
  const cards = rows.map((row) => toCard(row, { whyIndex }));
  if (json) console.log(JSON.stringify(cards, null, 2));
  else console.log(renderDigest(cards));
  if (ack && rows.length) {
    markSeen(db, rows.map((r) => r.id));
    console.log(`\n(${rows.length} deltas marked seen)`);
  }
}

function filterRows(rows, whyIndex, only) {
  if (!only) return rows;
  const filters = only.split(',').map((value) => value.trim()).filter(Boolean);
  if (!filters.length) fail('Usage: what-changed report [--json] [--ack] [--only <kind[,kind…]|blockers>]');
  return rows.filter((row) => {
    const fact = whyIndex.get(row.object_id);
    return filters.includes(row.kind) || (filters.includes('blockers') && fact?.source === 'dependency');
  });
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

function cmdWatch(target, { reason = 'watched manually' } = {}) {
  const { connector, externalId } = parseObjectTarget(target, 'watch');
  const db = openConfiguredStore(loadConfig());
  const object = findObject(db, connector, externalId);
  if (!object) fail(`Cannot watch ${target}: object does not exist in the local store.`);
  // A watch is also an explicit reversal of a previous ignore; keep all other
  // source facts intact so relevance history resumes naturally.
  clearWatchFact(db, object.id, 'ignored');
  setWatchFact(db, object.id, 'manual', { reason });
  console.log(`Watching ${target}.`);
}

function cmdUnwatch(target) {
  const { connector, externalId } = parseObjectTarget(target, 'unwatch');
  const db = openConfiguredStore(loadConfig());
  const object = findObject(db, connector, externalId);
  if (!object) fail(`Cannot unwatch ${target}: object does not exist in the local store.`);
  // Ignored is a persistent read-time veto. Connector reconciliation does not
  // touch it, while dropping manual avoids an accidental resurrection later.
  setWatchFact(db, object.id, 'ignored');
  clearWatchFact(db, object.id, 'manual');
  console.log(`Unwatched ${target}.`);
}

function parseObjectTarget(target, verb) {
  const separator = target?.indexOf(':') ?? -1;
  if (separator <= 0 || separator === target.length - 1) {
    fail(`Usage: what-changed ${verb} <connector:external_id>${verb === 'watch' ? ' [--reason <text>]' : ''}`);
  }
  return { connector: target.slice(0, separator), externalId: target.slice(separator + 1) };
}

function findObject(db, connector, externalId) {
  return db.prepare('SELECT * FROM objects WHERE connector = ? AND external_id = ?').get(connector, externalId);
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
  const whyIndex = watchIndex(db);
  console.log(renderDigest(unseenDeltas(db).map((row) => toCard(row, { whyIndex }))));
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'sync': await cmdSync(); break;
  case 'report': {
    const onlyIndex = rest.indexOf('--only');
    if (onlyIndex >= 0 && !rest[onlyIndex + 1]) {
      fail('Usage: what-changed report [--json] [--ack] [--only <kind[,kind…]|blockers>]');
    }
    cmdReport({ json: rest.includes('--json'), ack: rest.includes('--ack'), only: onlyIndex >= 0 ? rest[onlyIndex + 1] : null });
    break;
  }
  case 'diff': {
    const fi = rest.indexOf('--format');
    cmdDiffFiles(rest[0], rest[1], { json: rest.includes('--json'), format: fi >= 0 ? rest[fi + 1] : null });
    break;
  }
  case 'mark-seen': cmdMarkSeen(); break;
  case 'mute': cmdMute(rest[0], rest[1]); break;
  case 'watch': {
    const reasonIndex = rest.indexOf('--reason');
    if (reasonIndex >= 0 && !rest[reasonIndex + 1]) {
      fail('Usage: what-changed watch <connector:external_id> [--reason <text>]');
    }
    cmdWatch(rest[0], { reason: reasonIndex >= 0 ? rest[reasonIndex + 1] : 'watched manually' });
    break;
  }
  case 'unwatch': cmdUnwatch(rest[0]); break;
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
  what-changed report [--json] [--ack] [--only <kind[,kind…]|blockers>]
                                    Show changes since you last looked; --only supports delta kinds or blockers
  what-changed diff <fileA> <fileB> [--json]
                                    Ad-hoc diff of two files (ADF via codec,
                                    plain JSON via structural diff)
  what-changed mark-seen            Reset your baseline to now
  what-changed mute <kind|path|object> <pattern>
                                    Silence a delta kind, path prefix, or object
  what-changed watch <connector:external_id> [--reason <text>]
                                    Manually watch a known object
  what-changed unwatch <connector:external_id>
                                    Persistently exclude a known object
  what-changed gc [--days N]        Drop aged snapshot payloads (auto-runs on sync)
  what-changed demo                 Self-contained fixture demo (no tokens needed)

Auth is BYOT: GITHUB_TOKEN, JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN.`);
}
