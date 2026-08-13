// GitHub connector: fetch + normalize only; the engine diffs (FOUNDING.md §8).
// BYOT auth: GITHUB_TOKEN from the environment. Cursor: ISO timestamp per repo.
import { ensureObject, ingestSnapshot, getCursor, setCursor } from '../core/store.js';
import { githubLens } from '../core/lens.js';
import { sha256 } from '../core/diff.js';

const API = 'https://api.github.com';

export async function sync(db, config, env = process.env) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set — what-changed is BYOT: create a PAT and export it.');
  const results = { objects: 0, changed: 0 };

  for (const repo of config.repos ?? []) {
    const since = getCursor(db, 'github', repo);
    const syncStartedAt = new Date().toISOString();
    const first = new URL(`${API}/repos/${repo}/issues`);
    first.searchParams.set('state', 'all');
    first.searchParams.set('per_page', '100');
    first.searchParams.set('sort', 'updated');
    if (since) first.searchParams.set('since', since);

    // Follow RFC 5988 Link pagination — a busy repo overflows one page on
    // the first sync, and silent truncation would corrupt the baseline.
    const issues = [];
    let next = first.toString();
    while (next) {
      const res = await fetch(next, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) throw new Error(`GitHub ${repo}: ${res.status} ${await res.text()}`);
      issues.push(...(await res.json()));
      next = (res.headers.get('link') ?? '').match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }

    for (const issue of issues) {
      const isPr = Boolean(issue.pull_request);
      const object = ensureObject(db, {
        connector: 'github',
        externalId: `${repo}#${issue.number}`,
        objectType: isPr ? 'pull_request' : 'issue',
        name: `${repo}#${issue.number} ${issue.title}`,
        url: issue.html_url,
      });
      const { changed } = ingestSnapshot(db, object, normalize(issue, isPr), { lens: githubLens });
      results.objects += 1;
      if (changed) results.changed += 1;
    }
    // Cursor = sync start, not "now": anything updated mid-sync is re-fetched next time.
    setCursor(db, 'github', repo, syncStartedAt);
  }
  return results;
}

function normalize(issue, isPr) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    is_pr: isPr,
    draft: issue.draft ?? null,
    merged: issue.pull_request?.merged_at ? true : isPr ? false : null,
    assignees: (issue.assignees ?? []).map((a) => a.login).sort(),
    labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).sort(),
    milestone: issue.milestone?.title ?? null,
    comments: issue.comments,
    body_hash: issue.body ? sha256(issue.body) : null, // redaction: body text never stored
    updated_at: issue.updated_at,
  };
}
