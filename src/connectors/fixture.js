// Fixture connector: ingests JSON files as observations. Powers the demo and
// the golden test corpus — every real connector's normalize() output can be
// captured as a fixture and replayed here.
import { readFileSync } from 'node:fs';
import { ensureObject, ingestSnapshot } from '../core/store.js';
import { lenses } from '../core/lens.js';

/**
 * Fixture file shape: { observations: [{ connector, external_id, object_type,
 * name, url, payload }] }. Ingest one file per point in time.
 */
export function ingestFixtureFile(db, filePath, { label = null } = {}) {
  const { observations } = JSON.parse(readFileSync(filePath, 'utf8'));
  const results = { objects: 0, changed: 0 };
  for (const obs of observations) {
    const object = ensureObject(db, {
      connector: obs.connector,
      externalId: obs.external_id,
      objectType: obs.object_type,
      name: obs.name,
      url: obs.url,
    });
    const { changed } = ingestSnapshot(db, object, obs.payload, {
      label,
      lens: lenses[obs.connector] ?? null,
    });
    results.objects += 1;
    if (changed) results.changed += 1;
  }
  return results;
}
