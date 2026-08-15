import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCursor, openStore, setCursor } from '../src/core/store.js';
import { sync as syncGitHub } from '../src/connectors/github.js';
import { sync as syncJira } from '../src/connectors/jira.js';
import { stubFetch } from './helpers/recorded.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDED = join(ROOT, 'fixtures', 'recorded');
const REPO = 'acme/widgets';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_ISSUES_PATH = `/repos/${REPO}/issues`;
const GITHUB_FIRST_PAGE_URL = githubIssuesUrl();
const GITHUB_NEXT_PAGE_URL = 'https://api.github.com/repos/acme/widgets/issues?per_page=100&page=2&state=all&sort=updated';
const GITHUB_ENV = { GITHUB_TOKEN: 'recorded-token' };
const JIRA_BASE_URL = 'https://acme.atlassian.net';
const JIRA_MYSELF_URL = `${JIRA_BASE_URL}/rest/api/3/myself`;
const JIRA_SEARCH_PATH = '/rest/api/3/search/jql';
const JIRA_FIELDS = 'summary,status,assignee,priority,labels,comment,issuelinks,description,updated';
const JIRA_SCOPE = 'project = PAY AND assignee = currentUser()';
const JIRA_ENV = {
  JIRA_BASE_URL,
  JIRA_EMAIL: 'viewer@example.test',
  JIRA_API_TOKEN: 'recorded-token',
};

const githubPage1 = recorded('github-issues-page1.json');
const githubPage2 = recorded('github-issues-page2.json');
const githubUser = recorded('github-user.json');
const jiraPage1 = recorded('jira-search-page1.json');
const jiraPage2 = recorded('jira-search-page2.json');
const jiraMyself = recorded('jira-myself.json');

function recorded(name) {
  return JSON.parse(readFileSync(join(RECORDED, name), 'utf8'));
}

function store(t) {
  const db = openStore(':memory:');
  t.after(() => db.close());
  return db;
}

function installFetch(t, routes) {
  const fetch = stubFetch(routes);
  t.after(() => fetch.dispose());
  return fetch;
}

function storedPayload(db, connector, externalId) {
  const row = db.prepare(
    `SELECT s.payload
     FROM objects o
     JOIN snapshots s ON s.id = o.last_snapshot_id
     WHERE o.connector = ? AND o.external_id = ?`
  ).get(connector, externalId);
  assert.ok(row?.payload, `expected a stored snapshot for ${connector}:${externalId}`);
  return JSON.parse(row.payload);
}

function githubIssueRequests(fetch) {
  return fetch.requests.filter(({ url }) => new URL(url).pathname === GITHUB_ISSUES_PATH);
}

function githubIssuesUrl(since = null) {
  const url = new URL(`https://api.github.com${GITHUB_ISSUES_PATH}`);
  url.searchParams.set('state', 'all');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('sort', 'updated');
  if (since) url.searchParams.set('since', since);
  return url.toString();
}

function githubNextPageUrl(since = null) {
  const url = new URL(`https://api.github.com${GITHUB_ISSUES_PATH}`);
  url.searchParams.set('per_page', '100');
  url.searchParams.set('page', '2');
  url.searchParams.set('state', 'all');
  url.searchParams.set('sort', 'updated');
  if (since) url.searchParams.set('since', since);
  return url.toString();
}

function jiraSearchUrl(jql, nextPageToken = null) {
  const url = new URL(`${JIRA_BASE_URL}${JIRA_SEARCH_PATH}`);
  url.searchParams.set('jql', jql);
  url.searchParams.set('fields', JIRA_FIELDS);
  url.searchParams.set('maxResults', '100');
  if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
  return url.toString();
}

function jiraSearchRequests(fetch) {
  return fetch.requests.filter(({ url }) => new URL(url).pathname === JIRA_SEARCH_PATH);
}

function primaryJiraRequests(fetch) {
  return jiraSearchRequests(fetch).filter(({ url }) => {
    const jql = new URL(url).searchParams.get('jql');
    return !jql.startsWith('key in');
  });
}

test('GitHub follows the recorded Link URL and persists normalized snapshots', async (t) => {
  const db = store(t);
  const fetch = installFetch(t, {
    [GITHUB_USER_URL]: githubUser,
    [GITHUB_FIRST_PAGE_URL]: {
      body: githubPage1,
      headers: { Link: `<${GITHUB_NEXT_PAGE_URL}>; rel="next"` },
    },
    [GITHUB_NEXT_PAGE_URL]: githubPage2,
  });

  const result = await syncGitHub(db, { repos: [REPO] }, GITHUB_ENV);
  const issueRequests = githubIssueRequests(fetch);

  assert.equal(result.objects, 3);
  assert.equal(issueRequests.length, 2);
  assert.deepEqual(issueRequests.map(({ method }) => method), ['GET', 'GET']);
  assert.equal(issueRequests[1].url, GITHUB_NEXT_PAGE_URL);
  assert.deepEqual(
    db.prepare(
      'SELECT external_id FROM objects WHERE connector = ? ORDER BY external_id'
    ).all('github').map(({ external_id }) => external_id),
    ['acme/widgets#101', 'acme/widgets#102', 'acme/widgets#103']
  );

  const pr = db.prepare(
    'SELECT url FROM objects WHERE connector = ? AND external_id = ?'
  ).get('github', 'acme/widgets#101');
  assert.equal(pr.url, 'https://github.com/acme/widgets/pull/101');
  assert.deepEqual(storedPayload(db, 'github', 'acme/widgets#101'), {
    number: 101,
    title: 'Add idempotency keys to checkout capture',
    state: 'open',
    is_pr: true,
    draft: false,
    merged: false,
    assignees: ['lee', 'octo-viewer'],
    labels: ['payments', 'ready for review'],
    milestone: 'Q3 checkout reliability',
    comments: 2,
    body_hash: 'a69f2c957ea9702ab5b11e5c6cc57b282dcefadee4c47e2a738a95b32a388034',
    updated_at: '2026-08-12T14:31:22Z',
  });
  assert.deepEqual(storedPayload(db, 'github', 'acme/widgets#103'), {
    number: 103,
    title: 'Remove an obsolete webhook retry note',
    state: 'closed',
    is_pr: false,
    draft: null,
    merged: null,
    assignees: [],
    labels: [],
    milestone: null,
    comments: 1,
    body_hash: null,
    updated_at: '2026-08-13T07:45:10Z',
  });
  assert.deepEqual(
    storedPayload(db, 'github', 'acme/widgets#102').labels,
    ['documentation', 'good first issue']
  );
});

test('GitHub records its cursor at sync start and reuses it as since', async (t) => {
  const db = store(t);
  let releaseGate;
  let signalEntered;
  let issueCalls = 0;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const fetch = installFetch(t, {
    '*': async ({ url }) => {
      if (url === GITHUB_USER_URL) return githubUser;
      if (new URL(url).pathname !== GITHUB_ISSUES_PATH) {
        throw new Error(`unexpected recorded route: ${url}`);
      }
      issueCalls += 1;
      if (issueCalls === 1) {
        signalEntered(new Date().toISOString());
        await gate;
      }
      return [];
    },
  });

  const t0 = new Date().toISOString();
  const firstSync = syncGitHub(db, { repos: [REPO] }, GITHUB_ENV);
  const enteredAt = await entered;
  releaseGate();
  await firstSync;

  const cursor = getCursor(db, 'github', REPO);
  assert.ok(Date.parse(t0) <= Date.parse(cursor), `${t0} should be no later than ${cursor}`);
  assert.ok(Date.parse(cursor) <= Date.parse(enteredAt), `${cursor} should be no later than ${enteredAt}`);

  await syncGitHub(db, { repos: [REPO] }, GITHUB_ENV);
  const issueRequests = githubIssueRequests(fetch);
  assert.equal(issueRequests.length, 2);
  assert.equal(new URL(issueRequests[1].url).searchParams.get('since'), cursor);
});

test('GitHub buffers all pages, so a page-two failure writes neither objects nor cursor', async (t) => {
  const db = store(t);
  const priorCursor = '2026-08-01T00:00:00.000Z';
  const firstPageUrl = githubIssuesUrl(priorCursor);
  const nextPageUrl = githubNextPageUrl(priorCursor);
  setCursor(db, 'github', REPO, priorCursor);
  installFetch(t, {
    [GITHUB_USER_URL]: githubUser,
    [firstPageUrl]: {
      body: githubPage1,
      headers: { Link: `<${nextPageUrl}>; rel="next"` },
    },
    [nextPageUrl]: { status: 500, text: 'recorded page-two failure' },
  });

  await assert.rejects(
    syncGitHub(db, { repos: [REPO] }, GITHUB_ENV),
    /GitHub acme\/widgets: 500 recorded page-two failure/
  );
  assert.equal(getCursor(db, 'github', REPO), priorCursor);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM objects WHERE connector = ?').get('github').count,
    0
  );
});

test('GitHub content auth errors include the repo and leave the cursor unchanged', async (t) => {
  const db = store(t);
  const priorCursor = '2026-08-01T00:00:00.000Z';
  const firstPageUrl = githubIssuesUrl(priorCursor);
  setCursor(db, 'github', REPO, priorCursor);
  const fetch = installFetch(t, {
    [GITHUB_USER_URL]: githubUser,
    [firstPageUrl]: { status: 401, text: 'issues auth denied' },
  });

  await assert.rejects(
    syncGitHub(db, { repos: [REPO] }, GITHUB_ENV),
    /GitHub acme\/widgets: 401 issues auth denied/
  );
  assert.equal(getCursor(db, 'github', REPO), priorCursor);
  assert.deepEqual(fetch.requests.map(({ url }) => url), [GITHUB_USER_URL, firstPageUrl]);
});

test('GitHub reports a BYOT token error before making any request', async (t) => {
  const db = store(t);
  const fetch = installFetch(t, { '*': [] });

  await assert.rejects(
    syncGitHub(db, { repos: [REPO] }, {}),
    /GITHUB_TOKEN not set.*BYOT/
  );
  assert.equal(fetch.requests.length, 0);
});

test('Jira follows nextPageToken and stores the full normalized recorded issue', async (t) => {
  const db = store(t);
  const initialJql = `(${JIRA_SCOPE}) AND updated >= -7d`;
  const fetch = installFetch(t, {
    [JIRA_MYSELF_URL]: jiraMyself,
    [jiraSearchUrl(initialJql)]: jiraPage1,
    [jiraSearchUrl(initialJql, jiraPage1.nextPageToken)]: jiraPage2,
    [jiraSearchUrl('key in (PAY-42)')]: { body: { issues: [] } },
  });

  const result = await syncJira(db, { jql_scope: JIRA_SCOPE }, JIRA_ENV);
  const primary = primaryJiraRequests(fetch);

  assert.equal(result.objects, 2);
  assert.equal(primary.length, 2);
  assert.equal(new URL(primary[1].url).searchParams.get('nextPageToken'), jiraPage1.nextPageToken);
  assert.deepEqual(
    db.prepare(
      "SELECT external_id FROM objects WHERE connector = 'jira' AND last_snapshot_id IS NOT NULL ORDER BY external_id"
    ).all().map(({ external_id }) => external_id),
    ['PAY-101', 'PAY-102']
  );
  assert.deepEqual(storedPayload(db, 'jira', 'PAY-101'), {
    key: 'PAY-101',
    summary: 'Make checkout capture idempotent',
    status: 'In Progress',
    assignee: 'Octo Viewer',
    priority: 'High',
    labels: ['backend', 'checkout', 'payments'],
    description_adf: {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Attach an idempotency key to every capture request.' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Keep the key for 24 hours.' }],
                },
              ],
            },
          ],
        },
      ],
    },
    comment_count: 2,
    last_comment_hash: '993de29d8fc3b4b6270f5778c51d4ec26e68bdda7e03bdb0ccb6e64abfbba8a6',
    links: [
      { id: '10001', type: 'Blocks', key: 'PAY-118' },
      { id: '10002', type: 'Blocks', key: 'PAY-42' },
    ],
  });
});

test('Jira cursor is scoped by JQL and sends its minute-granular value on the next sync', async (t) => {
  const db = store(t);
  const initialJql = `(${JIRA_SCOPE}) AND updated >= -7d`;
  const fetch = installFetch(t, {
    '*': ({ url }) => {
      if (url === JIRA_MYSELF_URL) return jiraMyself;
      const request = new URL(url);
      if (request.pathname !== JIRA_SEARCH_PATH) {
        throw new Error(`unexpected recorded route: ${url}`);
      }
      const jql = request.searchParams.get('jql');
      if (jql.startsWith('key in')) return { body: { issues: [] } };
      if (request.searchParams.get('nextPageToken') === jiraPage1.nextPageToken) return jiraPage2;
      if (jql === initialJql) return jiraPage1;
      if (jql.includes('updated >= "')) return { body: { issues: [] } };
      throw new Error(`unexpected Jira JQL: ${jql}`);
    },
  });

  await syncJira(db, { jql_scope: JIRA_SCOPE }, JIRA_ENV);
  const cursor = getCursor(db, 'jira', JIRA_SCOPE);
  assert.ok(cursor);

  await syncJira(db, { jql_scope: JIRA_SCOPE }, JIRA_ENV);
  const primary = primaryJiraRequests(fetch);
  const secondSyncJql = new URL(primary.at(-1).url).searchParams.get('jql');
  const cursorMinute = cursor.slice(0, 16).replace('T', ' ');
  assert.equal(primary.length, 3);
  assert.equal(new URL(primary[0].url).searchParams.get('jql'), initialJql);
  assert.ok(secondSyncJql.includes(`updated >= "${cursorMinute}"`));
});

test('Jira retains already-ingested page-one objects when page two fails without advancing its cursor', async (t) => {
  const db = store(t);
  const priorCursor = '2026-08-01T00:00:00.000Z';
  const initialJql = `(${JIRA_SCOPE}) AND updated >= "2026-08-01 00:00"`;
  setCursor(db, 'jira', JIRA_SCOPE, priorCursor);
  installFetch(t, {
    [JIRA_MYSELF_URL]: jiraMyself,
    [jiraSearchUrl(initialJql)]: jiraPage1,
    [jiraSearchUrl(initialJql, jiraPage1.nextPageToken)]: { status: 500, text: 'recorded page-two failure' },
  });

  await assert.rejects(
    syncJira(db, { jql_scope: JIRA_SCOPE }, JIRA_ENV),
    /Jira search: 500 recorded page-two failure/
  );
  assert.equal(getCursor(db, 'jira', JIRA_SCOPE), priorCursor);
  assert.equal(storedPayload(db, 'jira', 'PAY-101').key, 'PAY-101');
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM objects WHERE connector = 'jira' AND external_id = 'PAY-102'"
    ).get().count,
    0
  );
});

test('Jira blocker refresh uses a one-hop key JQL without an updated clause', async (t) => {
  const db = store(t);
  const initialJql = `(${JIRA_SCOPE}) AND updated >= -7d`;
  const fetch = installFetch(t, {
    [JIRA_MYSELF_URL]: jiraMyself,
    [jiraSearchUrl(initialJql)]: jiraPage1,
    [jiraSearchUrl(initialJql, jiraPage1.nextPageToken)]: jiraPage2,
    [jiraSearchUrl('key in (PAY-42)')]: { body: { issues: [] } },
  });

  await syncJira(db, { jql_scope: JIRA_SCOPE }, JIRA_ENV);
  const blockerRequest = jiraSearchRequests(fetch).find(({ url }) =>
    new URL(url).searchParams.get('jql') === 'key in (PAY-42)'
  );
  assert.ok(blockerRequest);
  assert.doesNotMatch(new URL(blockerRequest.url).searchParams.get('jql'), /\bupdated\b/i);
});

test('Jira search auth errors are clear and do not advance the cursor', async (t) => {
  const db = store(t);
  const priorCursor = '2026-08-01T00:00:00.000Z';
  const initialJql = `(${JIRA_SCOPE}) AND updated >= "2026-08-01 00:00"`;
  setCursor(db, 'jira', JIRA_SCOPE, priorCursor);
  const fetch = installFetch(t, {
    [JIRA_MYSELF_URL]: jiraMyself,
    [jiraSearchUrl(initialJql)]: { status: 401, text: 'search auth denied' },
  });

  await assert.rejects(
    syncJira(db, { jql_scope: JIRA_SCOPE }, JIRA_ENV),
    /Jira search: 401 search auth denied/
  );
  assert.equal(getCursor(db, 'jira', JIRA_SCOPE), priorCursor);
  assert.deepEqual(fetch.requests.map(({ url }) => url), [JIRA_MYSELF_URL, jiraSearchUrl(initialJql)]);
});

test('Jira reports missing BYOT environment before making any request', async (t) => {
  const db = store(t);
  const fetch = installFetch(t, { '*': [] });

  await assert.rejects(
    syncJira(db, { jql_scope: JIRA_SCOPE }, {}),
    /JIRA_BASE_URL \/ JIRA_EMAIL \/ JIRA_API_TOKEN not set.*BYOT/
  );
  assert.equal(fetch.requests.length, 0);
});
