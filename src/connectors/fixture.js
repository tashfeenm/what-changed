// Fixture connector: ingests JSON files as observations. Powers the demo and
// the golden test corpus — every real connector's normalize() output can be
// captured as a fixture and replayed here.
import { readFileSync } from 'node:fs';
import { ensureObject, ingestSnapshot, setWatchFact, setWatchEdge } from '../core/store.js';
import { profiles } from './profiles.js';

/**
 * Fixture file shape: { observations: [{ connector, external_id, object_type,
 * name, url, payload }], watches?: [...], edges?: [...] }. Ingest one file
 * per point in time.
 */
export function ingestFixtureFile(db, filePath, { label = null } = {}) {
  const { observations = [], watches = [], edges = [] } = JSON.parse(readFileSync(filePath, 'utf8'));
  const results = { objects: 0, changed: 0 };
  for (const obs of observations) {
    const object = ensureObject(db, {
      connector: obs.connector,
      externalId: obs.external_id,
      objectType: obs.object_type,
      name: obs.name,
      url: obs.url,
    });
    const profile = profiles[obs.connector] ?? {};
    const { changed } = ingestSnapshot(db, object, obs.payload, { label, ...profile });
    results.objects += 1;
    if (changed) results.changed += 1;
  }

  // Fixture relevance is connector-qualified so independently captured
  // sources cannot accidentally attach facts to an object with the same
  // external ID. Resolve references after observations so a fixture can
  // introduce an object and its relevance facts in one file.
  for (const watch of watches) {
    if (watch.source === 'dependency') {
      throw new Error("Fixture watch source 'dependency' is invalid; use fixture edges instead.");
    }
    const object = fixtureObject(db, watch.connector, watch.external_id);
    setWatchFact(db, object.id, watch.source, { reason: watch.reason ?? null });
  }
  for (const edge of edges) {
    const blocker = fixtureObject(db, edge.connector, edge.external_id);
    setWatchEdge(db, blocker.id, edge.deriving_key, edge.reason ?? null);
  }
  return results;
}

function fixtureObject(db, connector, externalId) {
  const object = db.prepare(
    'SELECT * FROM objects WHERE connector = ? AND external_id = ?'
  ).get(connector, externalId);
  if (!object) {
    throw new Error(`Fixture relevance references unknown object ${connector}:${externalId}`);
  }
  return object;
}
