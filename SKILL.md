---
name: what-changed
description: Answer "what changed?" with a local baseline instead of re-reading everything. Use when the user asks what changed since they last looked (Jira/GitHub work), or to compare two versions of any supported file (Markdown, ADF, Figma files, OpenAPI/Postman specs, Playwright a11y snapshots, JSON/YAML) — never eyeball two versions side by side.
---

# what-changed — a local change-memory layer

"What changed?" is only answerable against a remembered baseline. This tool
keeps one (local SQLite) and diffs against it. Never re-read full documents
or compare two versions by eye — ask for the delta.

## Commands (from this repo: `node src/cli.js …`; installed: `what-changed …`)

Tracked work (Jira/GitHub, BYOT tokens — see README for config):

```bash
what-changed sync            # pull current state into the baseline (GC rides along)
what-changed report --json   # change cards since the user last looked
what-changed report --ack    # …and mark them seen
what-changed mark-seen       # reset the baseline to now
```

Ad-hoc comparison of any two files (format auto-detected via read-better):

```bash
what-changed diff old.json new.json [--json]
# [CHANGED] GET /users: params role(query,required) added
# [CHANGED] TEXT "Title" edited
```

## Rules of thumb

- "What changed overnight / since Friday?" → `sync` then `report`. Render
  the change cards; every one carries a provenance URL — cite it.
- "Did the API/design/doc change between these two versions?" → `diff` the
  two files. Works for .md, ADF payloads, Figma file JSON, OpenAPI/Postman,
  a11y snapshots; plain JSON/YAML falls back to structural value diff.
- `seen` ≠ `synced`: syncing never marks anything seen. Only `--ack` /
  `mark-seen` moves the user's baseline — do that only after actually
  showing them the report.
- Noise control: `what-changed mute kind comment` etc. Suggest a mute when
  the user repeatedly skips a delta kind.
- Reading (not comparing) a file cheaply is read-better's job — use its
  skill for render/outline/get.
