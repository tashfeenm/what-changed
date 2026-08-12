// Jira Cloud connector: fetch + normalize only; the engine diffs.
// BYOT auth: JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN from the environment.
// Note: Jira also exposes upstream-native changelogs (bulk endpoint) — the
// prototype diffs snapshots for uniformity; changelog ingestion is a fast-follow.
import { ensureObject, ingestSnapshot, getCursor, setCursor } from '../core/store.js';
import { jiraLens } from '../core/lens.js';
import { sha256 } from '../core/diff.js';

export async function sync(db, config, env = process.env) {
  const base = env.JIRA_BASE_URL;
  const email = env.JIRA_EMAIL;
  const token = env.JIRA_API_TOKEN;
  if (!base || !email || !token) {
    throw new Error('JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set — what-changed is BYOT.');
  }
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const scope = config.jql_scope ?? 'assignee = currentUser() OR watcher = currentUser()';
  const since = getCursor(db, 'jira', scope);
  const syncStartedAt = new Date().toISOString();
  // JQL datetimes are minute-granular: "yyyy-MM-dd HH:mm".
  const jql = since
    ? `(${scope}) AND updated >= "${since.slice(0, 16).replace('T', ' ')}"`
    : `(${scope}) AND updated >= -7d`;

  const results = { objects: 0, changed: 0 };
  let nextPageToken = null;
  do {
    const url = new URL(`${base}/rest/api/3/search/jql`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', 'summary,status,assignee,priority,labels,comment,issuelinks,updated');
    url.searchParams.set('maxResults', '100');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);

    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Jira search: ${res.status} ${await res.text()}`);
    const page = await res.json();

    for (const issue of page.issues ?? []) {
      const object = ensureObject(db, {
        connector: 'jira',
        externalId: issue.key,
        objectType: 'issue',
        name: `${issue.key} ${issue.fields.summary}`,
        url: `${base}/browse/${issue.key}`,
      });
      const { changed } = ingestSnapshot(db, object, normalize(issue), { lens: jiraLens });
      results.objects += 1;
      if (changed) results.changed += 1;
    }
    nextPageToken = page.nextPageToken ?? null;
  } while (nextPageToken);

  setCursor(db, 'jira', scope, syncStartedAt);
  return results;
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
