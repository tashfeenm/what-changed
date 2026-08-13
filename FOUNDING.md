# what-changed — Founding Document

> **Status:** FOUNDING v0.3 — post-consult (Asha + Gem via Squeak) + prototype SHIPPED (2026-08-12): core store/diff/lenses/cards, Jira+GitHub connectors, fixture demo, CLI with autodetect ad-hoc diff. Reading/parsing extracted to sibling repo **read-better** (Tashfeen, same day): read-better makes reading efficient; what-changed answers "what changed?"
> **Date:** 2026-08-12
> **Authors:** Claud (Fable 5) + Tashfeen
> **License decision:** MIT (adoption-first; monetization is downstream of adoption — see §9)
> **One line:** A local change-memory layer for work tools — ask an agent "what changed?" across Jira, Confluence, Salesforce, Figma, GitHub, product builds, and API versions, and get a provenance-linked answer.
> **Coverage commitment (Tashfeen, 2026-08-12):** Jira · Confluence · Salesforce · Figma · GitHub · Playwright · Postman — rock-solid coverage for most large companies. All seven are committed roadmap; only the *order* is phased.
> **Category we're naming, not joining:** *local delta engine / temporal memory for agents* — this gives LLMs object permanence. It is NOT an "AI recap" (that's the incumbents' silo).

---

## 1. The Pain

People at companies need to know **"what changed?"** relative to their goals,
tasks, deliverables, and dependencies. The changes live in Jira, Confluence,
Salesforce, Figma, GitHub, staging builds, API versions — each with its own
notification stream, none of which answers the question *from the user's
point of view*. Keeping track of deltas across platforms is manual, lossy,
and daily.

Incumbent "AI recaps" (Atlassian Rovo, Glean, Slack AI) summarize activity
inside their own silo, or search across silos *statelessly*. None of them
maintains **your** baseline — what you last saw — so none can compute a true
delta, and none is agent-native.

## 2. The Thesis

**"What changed?" is only answerable relative to a remembered baseline.**
APIs are stateless; MCPs are stateless; the missing piece is a local,
user-owned state store that snapshots what you track and diffs against it.

The core primitive is `diff(snapshotA, snapshotB)`. Everything else —
connectors, dashboards, skills — is a way of producing snapshots or
rendering deltas.

**"Agent-native," operationally** (not a vibe — a contract):
- an MCP tool interface (`what_changed(scope, since)`, `diff(a, b)`);
- stable local state that outlives every session;
- machine-readable deltas (change cards, §7) — never prose-only;
- a provenance URL on every delta;
- relevance ranking the caller can trust;
- idempotent `sync` / `report` commands safe to call from loops and CI.

Design DNA:
- **Persistence** — a local SQLite store that outlives every session.
- **Provenance** — every delta carries a deep link to the exact upstream
  change; the digest is *like* the change, it never replaces it.
- **Hash-delta economy** — content-addressed snapshots + merkle subtree
  hashes; unchanged state costs one hash comparison.
- **Semantic lenses as the product surface** — generic JSON diff is table
  stakes and noisy; the win condition is *"the ticket you depend on moved to
  Blocked"*, *"the API now requires a new auth header"*, *"this Figma
  component's spacing changed."* Lenses are first-class, not an afterthought.

## 3. v0.1 Wedge (consult-narrowed)

Both reviewers converged: prove ONE workflow deeply before the seven-domain
vision. **v0.1 = the Ship Loop's first two links:**

> **Jira + GitHub + SQLite core + CLI + MCP server + change cards.**
> Demo: *"What changed overnight that affects my work?"*

Deferred from v0.1 (still committed, §5): Figma (v0.2 flagship demo),
Playwright/Postman captured mode (v0.2), Confluence + Salesforce (v0.3),
dashboard (after the digest format stabilizes), usage learning (after
relevance heuristics prove out).

**Salesforce stays in the committed set** (Tashfeen override of the consult's
"cut it" advice): enterprise support departments live in Service Cloud —
"what changed on my cases overnight?" (status, owner, priority, new comments,
SLA milestones) is exactly this product's question, and it's a persona the
Jira-centric wedge doesn't reach. It ships v0.3 rather than v0.1 only because
its Connected-App auth is the worst first-run experience in the set.

**Auth for v0.1 is BYOT — bring your own token.** Personal access tokens
pasted once into the OS keychain (fallback: a local config file, never the
repo). No OAuth dances, no Connected Apps, no private dev-app provisioning.
The first-run experience is: paste two tokens, run `what-changed sync`,
ask the question. OAuth flows arrive with the connectors that require them.

## 4. Two Source Modes, One Diff Core

**TRACKED** sources (cursor-synced, continuous — "what changed since I last
looked?"): Jira, GitHub, then Confluence, Figma, Salesforce.

**CAPTURED** sources (explicit, point-in-time — "what changed between A and
B?"): Playwright (build UI states), Postman (API surfaces + live run
reports). You name the snapshots (`build-123`, `v2.1-api`) and diff any two.

Both land in the same store, flow through the same diff core, and render in
the same digest with the same provenance discipline.

```
  TRACKED (cursor-synced)                  CAPTURED (point-in-time)
  Jira · GitHub · Confluence ·             Playwright (builds) ·
  Figma · Salesforce                       Postman (API versions)
        │ sync loop                              │ capture --label build-123
        ▼                                        ▼
  ┌───────────────────────────────────────────────────────┐
  │ Snapshot store (SQLite, content-addressed, merkle,    │
  │ redaction before write, GC from day one)              │
  ├───────────────────────────────────────────────────────┤
  │ Diff core (generic JSON/tree diff) + semantic lenses  │
  ├───────────────────────────────────────────────────────┤
  │ Relevance (watchlist, dependency edges, noise controls)│
  ├───────────────────────────────────────────────────────┤
  │ Facades: library · CLI · MCP server · skill · dashboard │
  └───────────────────────────────────────────────────────┘
```

## 5. Connector Matrix (API-verified 2026-08-12)

| Source | Mode | Version | Sync/capture path | Delta path |
|--------|------|---------|-------------------|------------|
| Jira | tracked | **v0.1** | JQL `updated > :cursor` | **Upstream-native**: per-field changelog; bulk endpoint `POST /rest/api/3/issue/changelog` covers the whole watchlist in one call |
| GitHub | tracked | **v0.1** | events / GraphQL cursors | Upstream-native (PRs, reviews, comments) |
| Figma | tracked | v0.2 | `/v1/files/{key}/versions` for revisions | Node-tree diff keyed on **stable node IDs** (added/removed/changed/moved); API supports `ids=` and `depth=` so merkle-guided partial fetch is native; webhooks (`FILE_UPDATE`, HMAC) when polling ages out |
| Playwright | captured | v0.2 | `playwright-cli snapshot` → **YAML a11y-tree** per route + screenshot (`--hires`) + console errors | Structural tree diff (semantic) + pixel diff (evidence) |
| Postman / OpenAPI | captured | v0.2 | collection/OpenAPI JSON + `postman collection run -r json` reports | Structural spec diff (endpoint removed, required param added, auth changed → *"this will break clients calling X"*) + run-report diff (passed on A, fails on B). No native spec-diff upstream — ours to build. CLI lacks OAuth 2.0 |
| Confluence | tracked | v0.3 | `GET /wiki/api/v2/pages` (cursor-paginated) | Version history + fetch any historical body (`/pages/{id}/versions/{n}`) → local body diff |
| Salesforce | tracked | v0.3 | `getUpdated()`/`getDeleted()` per SObject (UTC); SOQL `SystemModstamp > :cursor`; CDC streaming later | Field History Tracking when enabled; else snapshot diff. First-class object: **Service Cloud Cases** (status/owner/priority/comments/SLA) for support teams, plus Opportunities. Auth: Connected App + OAuth device flow — worst first-run in the set, which is why it's v0.3 not v0.1 |
| Slack | delivery, not source-of-truth | later | — | Digest delivery (DM push) + lightweight capture of decisions/mentions |

Cost gradient: Jira/GitHub/Confluence ship fast on upstream-native deltas;
the heavy diff machinery matures on Figma trees, Playwright snapshots, and
Postman specs.

## 6. State Store (SQLite)

```sql
objects        (id, connector, external_id, object_type, name, url,
                last_snapshot_id, watch_weight)
snapshots      (id, object_id, taken_at, label,          -- label for captured mode
                payload_hash, payload)                    -- content-addressed
subtree_hashes (snapshot_id, json_path, hash)             -- merkle, big trees only
deltas         (id, object_id, from_snapshot, to_snapshot, observed_at,
                kind,            -- created|removed|field|comment|node|status|route|endpoint
                path, before, after,
                summary,         -- lens output: "status: Backlog → In Progress"
                provenance_url,  -- deep link to the change upstream
                seen_at)         -- NULL = unread
cursors        (connector, scope, cursor_value, updated_at)
watchlist      (object_id, source,  -- assigned|mentioned|dependency|manual|inferred
                weight, updated_at)
mutes          (scope,              -- kind|path-pattern|object
                pattern, created_at)
```

**Hygiene, day one (consult-mandated):**
- **Redaction before write** — configurable rules strip secrets, customer
  names, oversized bodies, and (optionally) comment text before a payload
  ever lands in the store. Trust in local snapshotting depends on this.
- **GC from day one** — snapshots whose deltas are `seen` and older than the
  retention window drop their raw payload, keeping only `payload_hash` +
  computed delta summaries. The store must not bloat; a11y trees and Figma
  documents are large.
- **Seen ≠ synced.** "Since last sync" and "since I last *looked*" are
  different baselines. `seen_at` is set only by `mark-seen` (or an explicit
  render-and-acknowledge), never by the sync loop.

## 7. Change Cards (the universal delta object)

Every delta, from every source, renders to one compact machine-readable
object — CLI, MCP, skill, and dashboard all speak it:

```json
{
  "what": "Blocking ticket PROJ-42 moved from In Progress to Blocked",
  "why_it_matters": "Your ticket PROJ-51 is blocked by it",
  "source": "jira",
  "kind": "status",
  "confidence": "high",
  "provenance_url": "https://…/browse/PROJ-42?focusedId=…",
  "actions": ["open", "mark_seen", "mute_kind", "unwatch"]
}
```

## 8. Connector Contract & Relevance

Connectors **fetch + normalize only**; the engine diffs. Per-connector code
stays thin — this is what makes the connector treadmill survivable.

```ts
interface Connector {
  id: string;
  discover(scope: Scope): AsyncIterable<ObjectRef>;       // objects worth tracking
  fetch(ref: ObjectRef): Promise<Snapshot>;               // normalized JSON
  cursorQuery?(cursor: string): AsyncIterable<ObjectRef>; // cheap "changed since"
  lens: SemanticLens;   // JSON paths → human meaning + deep link (data, not code)
}
```

- **Generic diff layer:** RFC 6902-style structural diff of canonical JSON.
  Works day one for any new connector.
- **Semantic lenses:** path→meaning tables — data files, cheap to add,
  golden-tested (§10).

**Codecs (the parser layer, between fetch and diff) — live in the sibling
library [read-better](../read-better).** Raw content formats are not
diffable as strings: Jira/Confluence rich text is ADF JSON; specs are
OpenAPI/collection JSON with positional paths; Figma files are node trees.
Each format gets a **codec**: a pure function (no network, golden-tested)
that parses it into canonical blocks with a two-part contract — `id`
(identity: WHICH block; native when the format has real ids, content-derived
otherwise) and `hash` (fingerprint: WHAT it says, meta included). Same id +
different hash = changed in place; native-id blocks are never
similarity-re-paired. Shipped codecs (2026-08-12): ADF, Markdown, JSON +
YAML outline mode (shape-not-values + RFC 6901 `get`), Figma files,
OpenAPI/Postman, Playwright a11y snapshots. Division of labor: read-better
makes reading token-efficient (render/outline/get); what-changed owns ALL
comparison (`blockDiff` + `jsonDiff`) and routes document formats to block
diffing, data formats to value diffing. Connectors stay transport
(fetch+normalize); codecs own format; the diff core stays singular.

**Relevance:**
- **Watchlist seeding:** assigned-to-me, @-mentioned, I-commented,
  my-team's-board — emitted by `discover` with a source tag.
- **Dependency edges:** Jira issue links ("is blocked by") auto-watch the
  other ticket.
- **Noise controls from v0.1:** `mute` by kind/path/object, watch/unwatch,
  importance threshold, `--only blockers|breakages`. (Usage *learning* —
  decay/rank-up — arrives after these heuristics prove out.)

**Identity & scope, minimal model (v0.1):** one profile = one human, holding
per-connector identities (Jira accountId, GitHub login) mapped in config.
"My baseline" = that profile's `seen_at` marks. Multi-workspace and team
scopes are declared per connector in config; anything fancier waits for
evidence.

## 9. Distribution & Monetization

**License: MIT.** The target user is exclusively commercial (nobody diffs
Salesforce opportunities as a hobby), so any usage restriction tolls 100% of
the audience and triggers corporate-legal review for a free tool. Adoption
is the asset.

**One engine, five doors:**
1. **Library** (`packages/core`) — importable store + diff engine.
2. **CLI** — `what-changed sync | capture | report --since | diff A B |
   mark-seen | mute`. This is what CI calls.
3. **MCP server** — `what_changed(scope, since)`, `diff(a, b)`.
4. **Skill** — thin SKILL.md: when to reach for the CLI/MCP, how to render
   change cards.
5. **Dashboard** — reads the same SQLite; shows `seen_at IS NULL` only.
   Local server or single-file HTML export. (Post-v0.1.)

**Monetization ladder (all doors stay open under MIT):**
- Now: GitHub Sponsors (tip jar, not a plan) + **consulting funnel** — "the
  person who built the delta engine" gets hired for enterprise wiring,
  custom connectors, agent-infra advisory. Monetizes reputation, not
  licenses.
- Later, with usage data: open-core — hosted/shared state store, team
  dashboards with rollups, SSO/audit, premium connectors (ServiceNow,
  Workday, SAP — Salesforce is core roadmap, not premium).

## 10. Build Order & Proof Artifacts

1. **core** — store, generic diff, merkle, redaction, GC, change cards.
2. **Jira** connector (upstream-native deltas; proves the loop).
3. **GitHub** connector.
4. **CLI + MCP + skill facades.**
5. **Golden test corpus** — fixtures for Jira/GitHub (later Figma/Postman)
   diffs with expected change-card outputs. Credibility + contributor
   on-ramp; grows with every connector.
6. **Figma** node-tree differ — v0.2, the flagship engineering blog post.
7. **Playwright + Postman** captured mode — v0.2.
8. **Confluence + Salesforce** — v0.3 (Salesforce leads with Service Cloud
   Cases for support teams; record demos before fighting Connected-App setup).
9. **Dashboard** once the digest format stabilizes.

**Demo ladder (each is a README GIF / post):**
- *Overnight blocker* (v0.1): "While you slept: the ticket blocking PROJ-51
  got a comment, its status moved to Blocked, and the related PR failed CI."
- *Agent demo* (v0.1): in Claude Code — "What changed since I last worked on
  checkout?" → MCP call → ranked, provenance-linked change cards.
- *Design drift* (v0.2): two Figma versions → button moved, text changed,
  component detached — provenance to exact node + version.
- *API breaking change* (v0.2): two OpenAPI specs → "endpoint removed,
  required param added — this will break clients calling X."
- *Cross-silo cascade* (the thesis-prover, v0.2+): "The checkout button
  changed blue→red in Figma; PR #142 is now out of sync with the design
  baseline; Playwright visual check failed on staging." Three tools, one
  diff.

Repo shape:

```
read-better/              # SIBLING REPO — token-efficient reading
  src/registry.js         # format detection (JSON-first, md hint-gated)
  src/codecs/             # adf/ markdown/ json/ yaml/ figma/ openapi/ a11y
  src/{blocks,yaml,outline}.js, SKILL.md

what-changed/             # THIS REPO — the delta engine (deps: read-better)
  src/core/               # store (SQLite), jsonDiff, blockDiff, lenses, cards
  src/connectors/         # jira/ github/ + profiles (lens + field differs)
  src/diff-files.js       # ad-hoc "what changed between A and B" checker
  src/cli.js              # sync | report | diff | mark-seen | mute | demo
  # later: mcp/ (v0.2 facade), skill/, dashboard/
```

## 11. Risks

- **First-run auth cliff** — the top adoption killer per consult. Mitigated
  by BYOT tokens (§3); OAuth only where unavoidable, and those connectors
  ship later.
- **State bloat** — a11y trees and Figma files are big. Mitigated by GC +
  content-addressing from day one (§6).
- **Connector treadmill** — APIs churn; every connector is a support
  surface. Mitigation: thin connectors (fetch+normalize only), lenses as
  data, generic diff as default, golden corpus catching drift.
- **Noisy diffs** — generic JSON diff without lens curation reads as spam
  and burns trust. Lenses + mutes + thresholds are v0.1 scope, not polish.
- **Incumbent recaps improve** — defensible ground is agent-native,
  local-first, delta-precise, user-owned state. Incumbents won't own *your*
  baseline across *their competitors'* silos.
- **Scope creep toward "platform"** — the simile lesson applies: this is a
  tool first; platforms are earned from products.

## 12. Open Questions

- Snapshot retention window defaults (GC policy is decided; the numbers
  aren't).
- Digest delivery beyond pull (Slack DM, morning push) — v0.2 at earliest.
- Whether Figma diffing wants a rendered visual layer (image exports per
  node) on top of the tree diff.
- `simulate_impact(change_proposal)` (Gem): with a local dependency graph +
  baselines, an agent could ask "if I change this schema, which tickets/PRs
  are affected?" Speculative — park until the graph exists and is trusted.
- Additional acquisition paths beyond REST polling, as future snapshot
  producers behind the same store: webhooks/event streams (Figma
  `FILE_UPDATE`, Salesforce CDC), audit-log ingestion, browser-extension
  capture for tools without APIs, email-notification parsing.

---

## Appendix: Consult Record (Squeak, 2026-08-12)

**Asha** — thesis sound; the gap is real. Sharpest framing: *"a local-first
change memory layer for agents,"* not "AI summaries across tools." Pushed:
narrow v0.1 to Jira+GitHub; define "agent-native" operationally; specify
identity/scope minimally; semantic lens quality IS the product; redaction +
retention early; change cards; seen≠synced; noise controls; golden corpus;
cut Salesforce/dashboard/usage-learning from v0.1; one-paragraph
monetization. Taglines offered: *"Git diff for everything your agent needs
to remember."*

**Gem** — thesis "incredibly sharp"; giving LLMs *object permanence*.
Pushed: BYOT tokens to kill the first-run auth cliff; aggressive GC day one;
cut Salesforce from v1 and stick to the Ship Loop (Jira→Figma→GitHub→
Playwright/Postman); cross-silo cascade as the holy-grail demo;
`simulate_impact` skill idea; category name: *local delta engine / temporal
memory for agents*. Win condition: an agent answering "did my PR actually
fix the bug reported in Jira yesterday?" without hallucinating.

All accepted except: `simulate_impact` parked (§12); Slack kept as
delivery-only (§5); Figma stays v0.2 rather than cut, because the design-
drift demo carries the blog-post/portfolio goal; **Salesforce restored to
the committed set at v0.3 (Tashfeen, 2026-08-12)** — enterprise support
departments (Service Cloud Cases) are a persona the consult under-weighted.
