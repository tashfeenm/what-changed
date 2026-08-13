// Connector profiles: everything the ingest path needs per connector —
// the semantic lens plus any per-field custom differs. Format expertise
// (parsing, labels) comes from read-better; comparison lives in our core.
import { parse } from 'read-better';
import { blockDiff } from '../core/blockdiff.js';
import { githubLens, jiraLens } from '../core/lens.js';

const EMPTY_DOC = { type: 'doc', version: 1, content: [] };

/** ADF field differ: parse both versions, diff at block level. */
export function adfFieldDiffer(fieldName, label = 'description') {
  return (before, after) => {
    try {
      const ops = blockDiff(parse(before ?? EMPTY_DOC), parse(after ?? EMPTY_DOC));
      return ops.map((op) => ({
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
