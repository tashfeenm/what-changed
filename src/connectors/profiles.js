// Connector profiles: everything the ingest path needs per connector —
// the semantic lens plus any per-field custom differs. Kept out of core so
// core stays dependency-free; format expertise lives in codecs (adf-codec).
import { diff as adfDiff } from 'adf-codec';
import { githubLens, jiraLens } from '../core/lens.js';

const EMPTY_DOC = { type: 'doc', version: 1, content: [] };

/** ADF field differ: block-level ops with adf-codec's edit re-pairing. */
export function adfFieldDiffer(fieldName, label = 'description') {
  return (before, after) => {
    try {
      return adfDiff(before ?? EMPTY_DOC, after ?? EMPTY_DOC).map((op) => ({
        op: 'replace',
        path: `/${fieldName}`,
        before: op.before ?? null,
        after: op.after ?? null,
        kind: 'content',
        summary: `${label}: ${op.summary}`,
      }));
    } catch {
      // Malformed/unknown ADF: degrade to a single opaque delta, never crash a sync.
      return [{ op: 'replace', path: `/${fieldName}`, before: null, after: null, kind: 'content', summary: `${label} changed` }];
    }
  };
}

export const profiles = {
  github: { lens: githubLens },
  jira: { lens: jiraLens, differs: { description_adf: adfFieldDiffer('description_adf') } },
};
