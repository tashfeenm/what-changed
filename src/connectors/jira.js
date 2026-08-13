// Jira Cloud connector: fetch + normalize only; the engine diffs.
// BYOT auth: JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN from the environment.
// Note: Jira also exposes upstream-native changelogs (bulk endpoint) — the
// prototype diffs snapshots for uniformity; changelog ingestion is a fast-follow.
import {
  ensureObject,
  ingestSnapshot,
  getCursor,
  setCursor,
  clearWatchFact,
  setWatchFact,
  reconcileWatchEdges,
} from '../core/store.js';
import { sha256 } from '../core/diff.js';
import { profiles } from './profiles.js';

const ISSUE_FIELDS = 'summary,status,assignee,priority,labels,comment,issuelinks,description,updated';
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

export async function sync(db, config, env = process.env) {
  const base = env.JIRA_BASE_URL?.replace(/\/+$/, '');
  const email = env.JIRA_EMAIL;
  const token = env.JIRA_API_TOKEN;
  if (!base || !email || !token) {
    throw new Error('JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set — what-changed is BYOT.');
  }
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const headers = { Authorization: auth, Accept: 'application/json' };
  // Relevance is advisory: an unavailable identity endpoint must never stop a
  // normal content sync. The fall-back tracked fact still makes the issue
  // observable without claiming it is assigned to the current user.
  const myAccountId = await viewerAccountId(base, headers);
  const scope = config.jql_scope ?? 'assignee = currentUser() OR watcher = currentUser()';
  const since = getCursor(db, 'jira', scope);
  const syncStartedAt = new Date().toISOString();
  // JQL datetimes are minute-granular: "yyyy-MM-dd HH:mm".
  const jql = since
    ? `(${scope}) AND updated >= "${since.slice(0, 16).replace('T', ' ')}"`
    : `(${scope}) AND updated >= -7d`;

  const results = { objects: 0, changed: 0 };
  const ingestedKeys = new Set();

  // Content capture is shared by primary-scope issues and their one-hop
  // blockers. Relevance is intentionally not: a blocker was returned only
  // because a primary issue linked to it, not because it matched the JQL
  // scope itself.
  const observeContent = (issue) => {
    const object = ensureObject(db, {
      connector: 'jira',
      externalId: issue.key,
      objectType: 'issue',
      name: `${issue.key} ${issue.fields.summary}`,
      url: `${base}/browse/${issue.key}`,
    });
    const { changed } = ingestSnapshot(db, object, normalize(issue), profiles.jira);
    results.objects += 1;
    if (changed) results.changed += 1;
    return object;
  };

  const observePrimary = (issue) => {
    // Relevance derives from raw Jira fields, before normalize intentionally
    // drops account IDs and reduces links to snapshot-safe shape.
    const watch = deriveJiraWatch(issue, myAccountId);
    const blockerKeys = deriveBlockerKeys(issue);
    const object = observeContent(issue);
    ingestedKeys.add(issue.key);

    // Connector-owned facts are rewritten every time an object is observed.
    // Manual and ignored facts deliberately remain untouched.
    rewriteConnectorWatch(db, object, watch);

    // An edge is one fact per deriving issue, rather than one lossy
    // "dependency" row per blocker. Placeholders make a dependency visible
    // even when Jira no longer returns it (for example, no permission).
    const edges = blockerKeys.map(({ key, reason }) => {
      const blocker = ensureDependencyObject(db, base, key);
      return { blockerObjectId: blocker.id, reason };
    });
    reconcileWatchEdges(db, issue.key, edges);
  };

  await searchJql(base, headers, jql, observePrimary);

  // Dependency edges persist between cursor-limited searches, so inspect the
  // current edge table rather than only the links encountered on this run.
  // This keeps known blockers fresh while avoiding a recursive graph crawl.
  const blockerKeys = dependencyKeys(db).filter((key) => !ingestedKeys.has(key));
  for (let start = 0; start < blockerKeys.length; start += 50) {
    const keys = blockerKeys.slice(start, start + 50);
    // Keep blocker refreshes one-hop and relevance-neutral. In particular,
    // do not turn a refetched blocker's own links into fresh dependency
    // edges: only primary JQL observations are allowed to seed relevance.
    await searchJql(base, headers, `key in (${keys.join(',')})`, observeContent);
  }

  setCursor(db, 'jira', scope, syncStartedAt);
  return results;
}

/**
 * Resolve a Jira issue's connector-owned relevance fact from the raw API
 * object. Keep this boundary raw: normalized payloads intentionally reveal
 * display names, not account IDs.
 */
export function deriveJiraWatch(issue, myAccountId) {
  const assigneeAccountId = issue?.fields?.assignee?.accountId;
  if (assigneeAccountId != null && myAccountId != null && assigneeAccountId === myAccountId) {
    return { source: 'assigned', reason: 'assigned to you' };
  }
  return { source: 'tracked', reason: 'matches your JQL scope' };
}

/**
 * Return blockers represented by Jira's inward link direction. For a link
 * whose inward wording is "is blocked by", inwardIssue is the blocker.
 */
export function deriveBlockerKeys(issue) {
  const reason = `${issue?.key} is blocked by it`;
  const edges = [];
  for (const link of issue?.fields?.issuelinks ?? []) {
    if (!/is blocked by/i.test(String(link?.type?.inward ?? ''))) continue;
    const key = link?.inwardIssue?.key;
    if (typeof key !== 'string' || !JIRA_KEY.test(key)) continue;
    edges.push({ key, reason });
  }
  return edges;
}

/** Fetch the account ID once; relevance failure must not abort a content sync. */
async function viewerAccountId(base, headers) {
  try {
    const res = await fetch(`${base}/rest/api/3/myself`, { headers });
    if (!res.ok) return null;
    return (await res.json())?.accountId ?? null;
  } catch {
    return null;
  }
}

/** Search Jira's cursor-paginated JQL endpoint and handle every returned issue. */
async function searchJql(base, headers, jql, observe) {
  let nextPageToken = null;
  do {
    const url = new URL(`${base}/rest/api/3/search/jql`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', ISSUE_FIELDS);
    url.searchParams.set('maxResults', '100');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Jira search: ${res.status} ${await res.text()}`);
    const page = await res.json();
    for (const issue of page.issues ?? []) observe(issue);
    nextPageToken = page.nextPageToken ?? null;
  } while (nextPageToken);
}

function rewriteConnectorWatch(db, object, fact) {
  clearWatchFact(db, object.id, 'assigned');
  clearWatchFact(db, object.id, 'tracked');
  setWatchFact(db, object.id, fact.source, { reason: fact.reason });
}

/** Current Jira dependency objects, one key per blocker even with shared edges. */
function dependencyKeys(db) {
  return db.prepare(
    `SELECT DISTINCT o.external_id
     FROM watch_edges e
     JOIN objects o ON o.id = e.blocker_object_id
     WHERE o.connector = 'jira'
       AND NOT EXISTS (
         SELECT 1 FROM watches w
         WHERE w.object_id = o.id AND w.source = 'ignored'
       )
     ORDER BY o.external_id`
  ).all()
    .map((row) => row.external_id)
    .filter((key) => JIRA_KEY.test(key));
}

function ensureDependencyObject(db, base, key) {
  // A blocker can already be part of the main JQL result. Do not replace its
  // real title with placeholder text merely because another issue links to it.
  const existing = db.prepare(
    'SELECT * FROM objects WHERE connector = ? AND external_id = ?'
  ).get('jira', key);
  if (existing) return existing;
  return ensureObject(db, {
    connector: 'jira',
    externalId: key,
    objectType: 'issue',
    name: `${key} (dependency)`,
    url: `${base}/browse/${key}`,
  });
}

export function normalize(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    priority: f.priority?.name ?? null,
    labels: (f.labels ?? []).slice().sort(),
    // Rich text kept as raw ADF; the profile's field differ (adf-codec)
    // turns edits into block-level deltas ("code block (bash) edited").
    description_adf: f.description ?? null,
    comment_count: f.comment?.total ?? 0,
    // Redaction: comment bodies are never stored — only a content hash of the
    // latest comment, enough to detect edits without retaining text.
    last_comment_hash: f.comment?.comments?.length
      ? sha256(JSON.stringify(f.comment.comments.at(-1).body ?? ''))
      : null,
    links: (f.issuelinks ?? [])
      .map((l) => ({
        id: l.id,
        type: l.type?.name ?? 'link',
        key: l.inwardIssue?.key ?? l.outwardIssue?.key ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
