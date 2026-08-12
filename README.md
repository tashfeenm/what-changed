# what-changed

> A local change-memory layer for work tools. Ask an agent **"what changed?"**
> across Jira, GitHub (and soon Confluence, Salesforce, Figma, builds, and API
> versions) — get a provenance-linked answer computed against *your* baseline.

**Why:** "What changed?" is only answerable relative to what you last saw.
APIs are stateless; so are MCPs and every AI recap bot. `what-changed` keeps a
local, user-owned SQLite baseline and diffs against it. Git diff for
everything your agent needs to remember.

## Try it in 10 seconds (no tokens needed)

```bash
node src/cli.js demo
```

## Real usage (BYOT — bring your own token)

```bash
export GITHUB_TOKEN=ghp_…              # a classic PAT with repo scope
# optional: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN

cat > what-changed.config.json <<'EOF'
{
  "db": "what-changed.db",
  "connectors": {
    "github": { "repos": ["your-org/your-repo"] },
    "jira": { "jql_scope": "assignee = currentUser() OR watcher = currentUser()" }
  }
}
EOF

what-changed sync        # pull current state into your local baseline
# … time passes …
what-changed sync
what-changed report      # what changed since you last looked
what-changed report --ack  # …and mark it seen
```

Every delta is a **change card**: what happened, why it matters, and a
provenance deep-link to the exact upstream change. `--json` emits cards
machine-readably (this is what the MCP server and skill consume).

## Design

See [FOUNDING.md](./FOUNDING.md). Short version: connectors fetch + normalize
only; a generic structural diff plus per-connector **semantic lenses** turn
snapshots into human deltas; `seen` is an explicit act, never a side effect of
syncing; comment/body text is hashed, not stored (redaction by default).

## Status

Founding prototype: core store + diff + lenses + change cards, GitHub and
Jira connectors, fixture corpus, CLI. Next: MCP server, skill, Figma
node-tree differ, Playwright/Postman captured mode, Confluence, Salesforce
(Service Cloud cases).

MIT.
