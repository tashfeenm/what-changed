# what-changed

> A local change-memory layer for work tools. Ask an agent **"what changed?"**
> across Jira, GitHub (Confluence, Salesforce, Figma tracking coming) — or
> between any two versions of a file — and get a provenance-linked answer
> computed against *your* baseline.

**Why:** "What changed?" is only answerable relative to what you last saw.
APIs are stateless; so are MCPs and every AI recap bot. `what-changed` keeps
a local, user-owned SQLite baseline and diffs against it. Git diff for
everything your agent needs to remember.

## Try it in 10 seconds (no tokens needed)

```bash
node src/cli.js demo
```

## Ad-hoc diff: any two versions of anything supported

```bash
what-changed diff design-v1.json design-v2.json     # Figma file JSON
# [CHANGED] FRAME "Checkout / Desktop": children: 3 → 4
# [CHANGED] TEXT "Title" edited
# [ADDED]   INSTANCE "TrustBadge" added

what-changed diff api-v1.json api-v2.json           # OpenAPI / Postman
# [CHANGED] GET /users: params role(query,required) added
# [REMOVED] GET /orders/{id} removed
```

Formats auto-detect via the sibling library
[read-better](../read-better): Markdown, ADF (Jira/Confluence rich text),
Figma files, OpenAPI/Postman, Playwright a11y snapshots — plus structural
value diff for plain JSON/YAML. Mixed formats refuse loudly.

## Tracked mode (BYOT — bring your own token)

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

what-changed sync          # pull current state into your local baseline
# … time passes …
what-changed sync
what-changed report        # what changed since you last looked
what-changed report --ack  # …and mark it seen
```

Every delta is a **change card**: what happened, why it matters, and a
provenance deep-link to the exact upstream change. `--json` emits cards
machine-readably (what the future MCP server and the skill consume).

## Design

See [FOUNDING.md](./FOUNDING.md). Short version: connectors fetch +
normalize only; read-better parses formats into canonical blocks (`id` =
identity, `hash` = fingerprint); one block differ + one value differ own all
comparison; **seen ≠ synced** (only an explicit ack moves your baseline);
Jira stores no comment text, only the latest fetched comment body hash
(`last_comment_hash`), while GitHub stores a comment count only and hashes
issue/PR bodies (`body_hash`). Jira descriptions are stored as full ADF for
block-level diffing. A configurable `store_content` redaction knob is
planned, and aged snapshot payloads are garbage-collected on every sync.

## Status

Working prototype: core store + differs + lenses + change cards, GitHub and
Jira Cloud connectors, ad-hoc multi-format diff, GC, fixture golden corpus,
CLI + SKILL.md. Next: Confluence and Salesforce (Service Cloud cases)
connectors, Playwright/Postman captured-mode labels, MCP facade, dashboard.

MIT.
