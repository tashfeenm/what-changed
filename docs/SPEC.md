# read-better + what-changed — System Specification v0.1

> Drafted by Sol (gpt-5.6-sol, xhigh) — 2026-08-13  
> Reviewed and finalized by Claud (Fable 5) — 2026-08-13: spot-verified the
> detection order, block/fingerprint contract, store semantics, and status
> ledger against the code and passing test runs; confirmed all four
> discrepancy findings (test scripts, privacy claim, fingerprint gaps, stale
> lockfile entry) independently. One audit artifact corrected in §6.1.  
> Owner: Tashfeen  
> Source of truth: the code and tests in `read-better` and `what-changed`; discrepancies with README, SKILL, or FOUNDING claims are recorded in the status ledger.

## 0. Status & Proposed Next Steps (updated 2026-08-15)

**Where things stand.** Four batches have landed through the
Terra-implements / Sol-signs-off / Claud-orchestrates pipeline since this
spec was drafted:

| Batch | Landed | Contents | Tests after |
|---|---|---|---|
| 1 | 2026-08-13 | Correctness: structural-field fingerprints, transactional ingestion, npm test scripts, precise privacy wording, lockfile | 27 rb / 19 wc |
| 2 | 2026-08-13 | Relevance engine: watch facts + dependency edges, `why_it_matters`, watch/unwatch/`--only`, ignored veto (1 sign-off rejection + fix round) | 41 wc |
| 3 | 2026-08-15 | Captured mode: `capture --label`, `captures`, `diff --labels`, replayCapture, atomic label uniqueness | 54 wc |
| 4 | 2026-08-15 | Connector hardening: recorded fixtures, 11 behavior tests, cursor proofs — zero production changes needed | 66 wc |

Every original P1 in §5 is now ✅ except the three items below. Both repos
are private on GitHub (`tashfeenm/read-better`, `tashfeenm/what-changed`).

**Remaining, in proposed order:**

1. **Batch 5 (proposed): Jira changelog ingestion + exact-change
   provenance** — one coherent brief closing the last two design-flavored
   P1s: ingest Jira's bulk changelog endpoint (upstream-native deltas
   instead of snapshot inference where available) and deep-link cards to
   the specific comment/changelog entry rather than the issue page.
2. **Live API validation** — needs Tashfeen (GitHub PAT; later a Jira
   instance). All behavior is recorded-fixture-proven; one real `sync`
   closes the final credibility gap. Pairs well with recording a demo GIF.
3. **Merkle/subtree hashes — recommend formal descope.** FOUNDING §6
   promises them; nothing at current file sizes needs them
   (payload-level content addressing already gives cheap no-ops). Proposal:
   amend FOUNDING to "deferred until a measured perf case", drop from P1.
4. **Then P2 breadth**, roughly in value order: Confluence connector
   (cheap on the hardened base), CI workflows (both repos), Salesforce /
   Service Cloud connector, npm publish prep, MCP facade, dashboard,
   `store_content` redaction knob, retry/backoff, usage learning.

## 1. Overview

`read-better` makes reading work-tool formats token-efficient. `what-changed` answers “what changed?” by comparing those formats or maintaining a local baseline across observations.

The shared thesis is that change requires a baseline, useful documents need blocks with identity, and every reported delta needs provenance. `read-better` converts format-specific input into canonical blocks or parsed data; `what-changed` remembers snapshots, compares the current observation with the previous one, applies semantic meaning, and emits provenance-linked change cards. Keeping block identity separate from block content lets native objects remain recognizable across edits, while `seen_at` keeps the user’s reading baseline distinct from the connector’s synchronization cursor.

Current packages:

| Repository | Package | Runtime | Dependencies |
|---|---|---:|---|
| `read-better` | `read-better@0.2.0` | Node.js `>=18` | None |
| `what-changed` | `what-changed@0.1.0` | Node.js `>=24` | Local `read-better` dependency |

Both are MIT licensed.

## 2. Shared contracts

### 2.1 Canonical Block contract

Document codecs produce raw blocks and finish them through `read-better/src/blocks.js:finalizeBlocks()`.

After finalization, the load-bearing fields are:

| Field | Contract |
|---|---|
| `id` | Identity: which block this is. It is either content-derived or supplied by a codec from a format-native identifier. |
| `idSource` | Exactly `'content'` or `'native'`; assigned by `finalizeBlocks()`. |
| `hash` | Twelve hexadecimal characters from SHA-256 over type, normalized comparable content, and canonicalized `meta`. |
| `type` | Codec-assigned block kind such as `heading`, `paragraph`, `node`, `endpoint`, or `a11y`. |
| `label` | Optional codec-assigned human label. It is not part of identity or fingerprinting. `render.js:labelOf()` supplies a shape-based fallback. |
| `meta` | Optional codec-assigned significant facts. `meta` participates in `hash`, but not content-derived `id`. |
| Content fields | Usually `text`; alternatively `items` or `rows`. Other rendering fields include `level`, `language`, `ordered`, `panelType`, `title`, and `ids`. |

`contentOf(block)` chooses comparable content in this order:

1. `items`, joined by newlines. String items remain strings; object items become `<state>:<text>`.
2. `rows`, with cells joined by `|` and rows joined by newlines.
3. `text`.
4. The empty string.

Normalization collapses whitespace, trims, and lowercases.

`fingerprint(block)` computes:

```text
sha256(type + ":" + normalize(contentOf(block)) + ":" + canonicalMeta(meta)
       + ":" + canonicalStructure(block))[0:12]
```

`canonicalMeta()` sorts top-level keys. Array values are converted to strings and sorted. Object-valued metadata is not recursively key-sorted.

`canonicalStructure()` (added Batch 1, 2026-08-13) covers the structural fields `level`, `language`, `ordered`, `panelType`, `title`, and `ids` — keys sorted, but the `ids` array order PRESERVED (media rendering is order-sensitive, so a reorder must change the hash).

For content-derived blocks, `finalizeBlocks()` computes:

```text
id = sha256(type + ":" + normalize(contentOf(block)))[0:8]
idSource = "content"
```

Metadata is deliberately excluded, so a metadata-only edit retains identity but changes `hash`.

For native-identity blocks:

```text
id = String(codecSuppliedId)
idSource = "native"
```

The codec must supply `id`; omission throws `codec bug: native-id block missing id`.

Within one parse, repeated base IDs receive occurrence suffixes: `base`, `base~1`, `base~2`, and so on. This applies to both native and content-derived IDs.

The codec assigns `type`, content fields, optional `label`, optional `meta`, and any native ID. `finalizeBlocks()` assigns `hash`, `idSource`, and the final collision-safe `id`.

Native-ID blocks are never similarity-re-paired. A native ID names a real upstream entity: a changed Figma node or OpenAPI endpoint retains its ID and is detected by a different `hash`; two different native IDs represent different things and must remain remove/add operations.

(The v0.1-draft fingerprint limitation — structural fields not participating — was closed by Batch 1: a heading level change or code-language change with identical text now produces a same-id/different-hash `changed` op. Verified by six table-driven cases in `read-better/test/codec.test.js`.)

### 2.2 Codec contract and registry

A codec exports `id`, `kind`, and one parser:

```js
// Document codec
{
  id: string,
  kind: 'document',
  parse(input): Block[],
  detectValue?(value): boolean,
  render?(blocks): string,
  acceptsText?: boolean
}

// Data codec
{
  id: string,
  kind: 'data',
  parseValue(input): unknown,
  detectValue?(value): boolean,
  acceptsText?: boolean
}
```

`read(input, options)` returns one of:

```js
{ codec, kind: 'document', blocks }
{ codec, kind: 'data', value }
```

The exact detection order in `read-better/src/registry.js` is:

1. `options.format` wins immediately through `codecById()`.
2. Already-parsed non-null objects skip text parsing and are sniffed in this order:
   `adf` → `openapi` → `figma` → generic `json`.
3. String input is attempted with strict `JSON.parse()`.
4. A successful bare JSON scalar is rejected; an object or array is sniffed:
   `adf` → `openapi` → `figma` → generic `json`.
5. If strict JSON did not parse, a `.md` or `.markdown` filename selects `markdown`.
6. Non-Markdown text beginning with `{` or `[` is treated as intended but malformed JSON and rejected loudly.
7. The YAML subset parser runs.
8. Only a structured YAML root—map or sequence—is eligible for detection.
9. YAML values are sniffed as `a11y` first, then `openapi`, then generic `yaml`.
10. Anything else raises `Could not detect format …`; Markdown is never the general fallback.

Consequences:

- Strict JSON always wins over YAML.
- JSON accessibility-shaped arrays remain generic JSON because `a11y` sniffing occurs only in the YAML family.
- OpenAPI may arrive as JSON or supported YAML.
- Markdown requires a filename hint or explicit `format`.
- A malformed JSON-looking `.md` file is Markdown because the filename check precedes the malformed-JSON guard.
- Explicit format selection chooses the codec but does not guarantee successful parsing.

`read-better/src/index.js:parse()` is document-only and throws for data codecs. `render()` is likewise document-only. Data is consumed through `read()`, `outlineModel()`, `outlineText()`, and `getPointer()`.

### 2.3 Diff routing

`what-changed/src/diff-files.js:diffFiles()` delegates parsing and detection to `read-better`.

- Different codec IDs are refused, even if both codecs are data formats.
- Matching `kind: 'document'` inputs route to `blockDiff(a.blocks, b.blocks)`.
- Matching `kind: 'data'` inputs route to `jsonDiff(a.value, b.value)`.
- `--format <id>` can force both inputs through one codec.
- Data outlines are never diffed because outlines intentionally discard values.

### 2.4 Change card contract

`what-changed/src/core/cards.js:toCard()` returns:

```json
{
  "what": "<object label>: <delta summary>",
  "why_it_matters": null,
  "source": "<connector>",
  "kind": "<delta kind>",
  "object": "<connector>:<external_id>",
  "confidence": "high",
  "provenance_url": "<delta or object URL, or null>",
  "observed_at": "<ISO timestamp>",
  "delta_id": 123,
  "actions": ["open", "mark_seen", "mute_kind", "unwatch"]
}
```

`object_name` is preferred over `external_id` in `what`.

`why_it_matters` can be populated only when a caller passes a `whyIndex` map keyed by `object_id`. Current CLI report and demo paths pass no index, so their cards always contain `null`.

`confidence` is currently the constant `'high'`. Actions are declarative; `unwatch` has no implemented CLI operation.

`renderDigest()` groups cards by `source` in first-seen order. `renderCard()` maps known kinds to display tags such as `STATUS`, `COMMENT`, `NEW`, `FIELD`, `DOC`, and `GONE`.

### 2.5 Connector and profile contract

The implemented connector contract differs from the aspirational `Connector` interface in `FOUNDING.md`. Live connectors currently expose:

```js
async function sync(db, config, env = process.env)
  // => { objects, changed }
```

A connector’s `sync()` performs transport, pagination, normalization, object upsert, snapshot ingestion, and cursor advancement. Comparison remains in the core.

The normalized observation boundary is:

```js
ensureObject(db, {
  connector,
  externalId,
  objectType,
  name,
  url
})

ingestSnapshot(db, object, payload, {
  label,
  lens,
  differs,
  provenanceUrl
})
```

`src/connectors/profiles.js` maps connector IDs to comparison behavior:

```js
{
  github: {
    lens: githubLens
  },
  jira: {
    lens: jiraLens,
    differs: {
      description_adf: adfFieldDiffer('description_adf')
    }
  }
}
```

A lens maps a generic JSON operation to `{kind, summary, provenanceUrl?}`, `{suppress: true}`, or `null`.

A field differ owns one top-level field. `store.js:computeOps()` removes that field from the generic diff and invokes the differ only when its canonical value changed. Custom differ operations already contain `kind` and `summary` and therefore bypass the lens.

`adfFieldDiffer()` parses old and new Jira descriptions with `read-better:parse()`, applies `blockDiff()`, and emits `kind: 'content'` operations at `/description_adf`. Parse failures degrade to one opaque `description changed` delta.

The fixture connector accepts:

```json
{
  "observations": [{
    "connector": "jira",
    "external_id": "PROJ-42",
    "object_type": "issue",
    "name": "…",
    "url": "…",
    "payload": {}
  }]
}
```

It chooses `profiles[connector]`, falling back to generic comparison for unknown connectors.

### 2.6 Store schema and baseline semantics

`what-changed/src/core/store.js:SCHEMA` creates:

| Table | Columns and constraints |
|---|---|
| `objects` | `id` PK; `connector`; `external_id`; `object_type`; nullable `name`, `url`, `last_snapshot_id`; `watch_weight REAL NOT NULL DEFAULT 1.0`; unique `(connector, external_id)`. |
| `snapshots` | `id` PK; `object_id`; `taken_at`; nullable `label`; `payload_hash`; nullable `payload`. |
| `deltas` | `id` PK; `object_id`; nullable `from_snapshot`; `to_snapshot`; `observed_at`; `kind`; `path`; nullable `before`, `after`; `summary`; nullable `provenance_url`, `seen_at`. |
| `cursors` | `connector`, `scope`, `cursor_value`, `updated_at`; composite PK `(connector, scope)`. |
| `watchlist` | `object_id` PK; `source`; `weight DEFAULT 1.0`; `updated_at`. |
| `mutes` | `scope`, `pattern`, `created_at`; composite PK `(scope, pattern)`. |

Indexes cover unseen deltas and snapshots by object/time. `openStore()` enables SQLite WAL and then applies the schema.

`ensureObject()` upserts by `(connector, external_id)`, updating `name` and `url`.

`ingestSnapshot()` canonicalizes the payload with recursively sorted object keys, hashes the resulting JSON with full SHA-256, and compares it with the current head:

- Same head hash with no `label`: no new snapshot; `changed: false`.
- A label bypasses that no-op, allowing an identical payload to become a named snapshot.
- A changed payload creates a snapshot, updates `last_snapshot_id`, diffs against the prior payload, and inserts unsighted deltas.
- A first observation creates one `kind: 'created'` database delta.
- `changed: true` means a snapshot was inserted; it does not guarantee that comparison produced delta operations.

Snapshot writes, head updates, and delta inserts are not wrapped in an explicit transaction.

Seen is not synced:

- `sync` never changes `seen_at`.
- `unseenDeltas()` selects `seen_at IS NULL`, applies mutes, and returns oldest first.
- `markSeen(db)` acknowledges every unseen delta.
- `markSeen(db, ids)` acknowledges only the given IDs.
- `report --ack` acknowledges only the visible, unmuted rows returned by that report.
- A mute hides matching deltas but does not mark them seen.
- `mark-seen` acknowledges muted and unmuted unseen deltas alike.

Mute matching is exact for `kind`, prefix-based for `path`, and exact against `<connector>:<external_id>` for `object`.

Garbage collection sets `snapshots.payload = NULL`; it keeps the snapshot row, hash, and computed deltas. A payload is eligible only when all conditions hold:

1. `payload IS NOT NULL`.
2. `label IS NULL`.
3. `taken_at` is older than the retention cutoff.
4. It is not any object’s `last_snapshot_id`.
5. No unseen delta references it as `from_snapshot` or `to_snapshot`.

The default retention window is 30 days. GC runs after `sync` and through the explicit `gc` verb.

The `watchlist` table and `objects.watch_weight` exist but have no reader, writer, ranking, or CLI path.

## 3. read-better component specification

### 3.1 Library surface

`src/index.js` exports:

```js
read
detect
parse
render
renderBlocks
labelOf
contentOf
fingerprint
outlineModel
outlineText
getPointer
inlineText
```

`src/index.d.ts` declares the corresponding TypeScript surface and `Block` types.

`renderBlocks()` is intentionally explicit: a bare JSON array is never inferred to be a block list.

### 3.2 ADF codec

File: `src/codecs/adf.js`  
Kind: `document`  
Identity: content-derived  
View: shared compact Markdown renderer

Accepted shapes:

- Bare `{type: 'doc', content: [...]}`.
- Jira issue payload with `fields.description`.
- Confluence v2 `body.atlas_doc_format.value` containing a JSON string.
- Wrapper with `body.type === 'doc'`.

Emitted blocks:

| ADF node | Block |
|---|---|
| `heading` | `heading` with `level`, `text` |
| nonempty `paragraph` | `paragraph` |
| `codeBlock` | `code` with `language`, raw text |
| `blockquote` | `quote` |
| `bulletList`, `orderedList` | `list` with `ordered`, flattened `items` |
| `taskList` | `tasks` with `{state: 'done'|'todo', text}` items |
| `table` | `table` with string `rows` |
| `panel` | `panel` with `panelType` |
| `expand`, `nestedExpand` | `expand` with `title` |
| `rule` | `rule` |
| `mediaSingle`, `mediaGroup` | `media` with `ids` and alt text |
| `decisionList` | `decisions` |
| unknown block node | Block retaining the node type and flattened text |

Inline handling preserves text, mentions, emoji, hard breaks, card URLs, status text, and dates. Code, strong, emphasis, strike, and link marks become lightweight Markdown. Underline, text color, and sub/superscript marks are dropped.

Known limits:

- It is not a complete implementation of all ADF nodes and attributes.
- Nested rich structure is flattened into block text.
- Empty paragraphs are discarded as layout.
- Several significant top-level block properties are not fingerprinted.
- Unknown nodes preserve recoverable text, not their full original structure.

### 3.3 Markdown codec

File: `src/codecs/markdown.js`  
Kind: `document`  
Identity: content-derived  
View: shared Markdown renderer

It accepts text only through `.md`/`.markdown` filename detection or explicit `--format markdown`.

Recognized structures are ATX headings, triple-backtick fenced code, bullet and ordered lists, task items, pipe tables, blockquotes, horizontal rules, paragraphs, and top-of-file YAML frontmatter.

Frontmatter beginning with `---` and ending with `---` or `...` becomes one opaque `frontmatter` block. It is preserved but not parsed.

Nested list items are flattened into the previous top-level item with `\n  - `. Indented continuation lines append to the preceding item.

Known limits:

- The parser is deliberately not CommonMark-complete.
- Inline Markdown is retained as text rather than parsed into inline nodes.
- Only triple-backtick fences are recognized.
- Table recognition expects pipe-shaped rows and a separator line.
- Setext headings, HTML block semantics, references, footnotes, and many escaping rules are not interpreted.
- Unknown constructs become paragraphs instead of disappearing.
- Ordered-list starting numbers are not retained; rendering renumbers from 1.

### 3.4 JSON codec

File: `src/codecs/json.js`  
Kind: `data`

Strictly parsed JSON objects and arrays not claimed by ADF, OpenAPI, or Figma return unchanged as `value`.

Bare JSON scalars are rejected during automatic detection. Generic JSON has no document renderer; its reading view is `outlineModel()`/`outlineText()`, followed by targeted `getPointer()` calls.

### 3.5 YAML codec and subset parser

Files: `src/codecs/yaml.js`, `src/yaml.js`  
Kind: `data`

Automatic detection accepts only a map or sequence root. Explicit `--format yaml` can parse a scalar root.

Supported features include:

- Block mappings and sequences.
- Nested maps and lists.
- `- key: value` object entries.
- Comments outside quotes.
- Single- and double-quoted strings.
- Lowercase `true`, `false`, `null`, and `~`.
- Integers and simple decimal numbers.
- Literal and folded blocks using `|`, `|-`, `>`, and `>-`.
- Single-line flow lists and maps, including nesting.

The strict-reject parser names unsupported or ambiguous constructs. Rejections include:

- Tab indentation when the line begins with a tab.
- Directives beginning with `%`.
- `---` and `...` multi-document markers.
- Inconsistent indentation.
- Duplicate keys.
- Anchors, aliases, and tags when encountered as scalar indicators.
- Reserved plain-scalar indicators `@` and backtick.
- Unterminated or trailing-content quoted scalars.
- Ambiguous plain scalars containing `: `.
- Multi-line or malformed flow collections.
- Empty flow scalars and flow mappings without `:`.

It does not implement the complete YAML specification: timestamps, scientific/hex/octal forms, alternate boolean spellings, chomping `+`, indentation indicators, complex keys, merge keys, or multi-document streams are not supported.

### 3.6 Accessibility snapshot codec

File: `src/codecs/a11y.js`  
Kind: `document`  
Identity: content-derived  
View: indented snapshot tree

Detection requires a nonempty top-level YAML list. At least 60% of extractable entries must have a single key matching the codec’s known ARIA-role allow-list.

Each node emits:

```js
{
  type: 'a11y',
  text: '<role> "<name>" [<attributes>]',
  label: '<role> "<name>"',
  meta: {
    role,
    depth,
    children
  }
}
```

Attributes remain opaque text; only role, depth, and immediate child count are structured. Unknown roles can be parsed after selection but do not help the automatic detection threshold.

### 3.7 Figma codec

File: `src/codecs/figma.js`  
Kind: `document`  
Identity: native Figma node IDs  
View: indented design-tree outline

It accepts a Figma REST file shape with:

```js
{
  document: {
    id: string,
    type: 'DOCUMENT',
    children: []
  }
}
```

The root `DOCUMENT` is not emitted. Retained node types are:

```text
CANVAS, FRAME, COMPONENT, COMPONENT_SET, INSTANCE, TEXT, GROUP, SECTION
```

Each retained node becomes a `node` block:

- `id`: Figma node ID.
- `label`: `<TYPE> "<name>"`.
- `text`: `characters` for `TEXT`; otherwise `name`.
- `meta.figmaType`: original type.
- `meta.depth`: depth among retained nodes.
- `meta.children`: immediate raw child count.
- Optional `meta.componentId`.
- Optional `meta.hidden: true`.

Unretained nodes are traversed but not emitted. Their presence can still affect a retained parent’s child count.

Visual properties such as coordinates, dimensions, colors, fills, strokes, constraints, and typography are ignored. Consequently, purely visual changes outside retained text/name/meta do not produce block changes.

### 3.8 OpenAPI and Postman codec

File: `src/codecs/openapi.js`  
Kind: `document`  
Identity: native operation IDs of the form `METHOD /path`  
View: compact endpoint listing

Detection accepts:

- An object with string `openapi` or `swagger`.
- A Postman-shaped object with `info` and array `item`.

OpenAPI emits an optional `#info` heading and one `endpoint` block per recognized HTTP method:

```js
{
  id: 'GET /users',
  type: 'endpoint',
  label: 'GET /users',
  text: operation.summary ?? operation.description ?? '',
  meta: {
    params,
    responses,
    auth?,
    requestBody?,
    deprecated?
  }
}
```

Path-level and operation-level parameters are combined. Parameters retain name, location, and requiredness. Responses become sorted status-code strings. Security records scheme names. Request bodies record sorted content types.

Postman folders are recursively flattened. Request IDs use the uppercase method plus URL with scheme and host removed when possible. Text is the request name; metadata includes query keys, auth type, and body mode.

Known limits:

- `$ref` values are not resolved.
- Parameter schemas, response bodies, headers, components, servers, callbacks, examples, and extensions are ignored.
- Postman scripts, saved responses, environments, variables, disabled parameters, and run reports are not modeled.
- The renderer shows labels, summary text, parameters, responses, and deprecation; it does not display stored auth or request-body metadata.
- Postman behavior has no dedicated automated fixture test.

### 3.9 Outline mode

Files: `src/outline.js`, `src/cli.js`

Defaults:

```text
depth = 3
samples = 2
SCAN_CAP = 200
KEY_CAP = 8
DOMAIN_CAP = 12
```

Array behavior:

- Reports total length.
- Scans at most the first 200 elements for shape inference.
- If scanned values are all objects, reports up to eight keys by frequency.
- A key absent from some scanned objects receives `?`.
- A larger array notes that shape came from the first 200 entries.
- Emits the first `samples` values, clipped to 72 characters.
- For string-valued object fields present in at least half the scanned objects, reports domains containing 2–12 distinct values.
- Domain output includes the three most frequent values and percentages.

Object behavior:

- The object description shows at most eight keys plus `+N more`.
- Recursion still visits all keys subject to `depth`.
- Paths are JSON Pointers.
- Scalars report type and a clipped JSON representation.

### 3.10 RFC 6901 targeted get

`getPointer(value, pointer)` implements JSON Pointer escaping:

```text
~1 → /
~0 → ~
```

Behavior:

- `''` returns the whole document.
- `'/'` addresses the empty-string property.
- Object keys must exist.
- Array segments are converted with `Number()` and must be in range.
- Missing keys, invalid roots, invalid indices, and pointers without an initial `/` throw descriptive errors.

The array parser is slightly more permissive than strict JSON Pointer array grammar because values such as `01` convert to integer `1`. Unknown `~` escape forms are left literal.

### 3.11 read-better CLI

All verbs accept a file path or `-` for stdin. `--format <id>` overrides detection.

| Verb | Behavior | Example |
|---|---|---|
| `render` | Document → codec-specific compact view | `read-better render fixtures/notes-v1.md` |
| `parse` | Document → blocks; data → parsed value, as pretty JSON | `read-better parse issue.json --format adf` |
| `detect` | Prints `<codec> (<kind>)` after parsing | `read-better detect fixtures/openapi-v1.json` |
| `outline` | Data → shape text or JSON model | `read-better outline data.json --depth 4 --samples 3 --json` |
| `get` | Data + JSON Pointer → selected value | `read-better get data.json /users/3/role` |

`render` rejects data codecs; `outline` and `get` reject document codecs.

## 4. what-changed component specification

### 4.1 Snapshot and delta store

The store is local SQLite with WAL. Upstream files and APIs remain ground truth; the database is intended to be rebuildable.

Canonicalization recursively sorts object keys while preserving array order. Content hashes cover the entire canonical payload.

Payload equality is checked only against the current object head; there is no global payload-deduplication table or unique hash constraint.

Labeled snapshots remain addressable through `snapshotByLabel(db, label)`, which returns the newest snapshot globally with that label. Labels are not scoped by object.

Cursors are keyed by connector and scope. `setCursor()` upserts the value and update timestamp.

### 4.2 Generic structural differ

File: `src/core/diff.js`  
Function: `jsonDiff(a, b, path = '')`

Operations have:

```js
{
  op: 'add' | 'remove' | 'replace',
  path,
  before,
  after
}
```

Objects are recursively compared by key.

Arrays of objects use the first common identity scheme available in this priority:

```text
id, key, external_id, number, name
```

A key qualifies when every element in that array is a plain object and has a non-null value for the key. Identity-based arrays ignore reordering and address elements by identity in the output path.

Other arrays compare positionally.

Duplicate identity values are not rejected and will overwrite earlier elements in the internal maps. If old and new arrays qualify under incompatible keys, the old array’s key wins.

### 4.3 Canonical block differ

File: `src/core/blockdiff.js`  
Function: `blockDiff(blocksA, blocksB)`

Output operations use:

```js
{
  op: 'added' | 'removed' | 'changed' | 'moved',
  type,
  label,
  before?,
  after?,
  summary
}
```

Algorithm:

1. Build ID maps for both block sequences.
2. For IDs present on both sides, compare `hash`; when absent, fall back to `contentOf()`.
3. Same ID plus different fingerprint emits `changed`.
4. Collect unmatched old and new blocks.
5. Greedily similarity-pair unmatched blocks of the same type.
6. Similarity pairing is allowed only when neither block has `idSource === 'native'`.
7. Similarity is word-set Jaccard over lowercase non-word-separated tokens.
8. The inclusive pairing threshold is `0.4`.
9. Remaining unmatched blocks emit `removed` or `added`.
10. Shared exact IDs are compared by longest common subsequence; shared IDs outside the LCS emit `moved`.

Similarity pairing is greedy in old-block order. Ties take the first currently available new block. Edited content-derived blocks can be reported as changed, but because their IDs differ they do not participate in subsequent move detection.

Special summaries cover heading retitles, task completion/counts, list length, table row count, and metadata additions/removals. Otherwise the summary is `<label> edited`, optionally with metadata detail.

### 4.4 Semantic lenses and suppression

File: `src/core/lens.js`

`makeLens()` evaluates rules in declaration order; first meaningful result wins.

GitHub rules cover:

- State.
- Title.
- Assignees.
- Labels.
- Comment-count increases.
- Draft/ready transitions.
- Merge state.
- Body hash as `description edited`.
- Suppression of `updated_at`.

Jira rules cover:

- Status.
- Assignee.
- Priority.
- Summary.
- Comment-count increases.
- Labels.
- Added links.
- Suppression of `last_comment_hash`.

When a matching rule returns no summary—for example, a comment count decrease—the operation falls through to the generic field summary rather than being suppressed.

Sorted arrays of strings still use positional JSON comparison, so inserting an earlier-sorting assignee or label can produce replacement plus addition operations rather than one set-style addition.

### 4.5 GitHub connector

File: `src/connectors/github.js`

Configuration:

```json
{
  "repos": ["owner/repository"]
}
```

Authentication is BYOT through `GITHUB_TOKEN`.

For each repository:

1. Read the cursor using connector `github` and scope equal to the repository name.
2. Record `syncStartedAt`.
3. Request `GET /repos/{repo}/issues`.
4. Set `state=all`, `per_page=100`, `sort=updated`, and optional `since`.
5. Follow RFC 5988 `Link` headers whose relation is `next`.
6. Treat rows with `pull_request` as pull requests.
7. Normalize and ingest each issue.
8. Set the cursor to the sync start time, not completion time.

Normalized fields are:

```text
number, title, state, is_pr, draft, merged,
assignees[], labels[], milestone, comments,
body_hash, updated_at
```

Assignees and labels are sorted. Body text is not stored; `body_hash` is SHA-256 of the body.

The connector does not fetch PR details, reviews, checks, events, individual comments, or upstream-native event deltas. Provenance defaults to the issue/PR `html_url`.

There is no retry, backoff, rate-limit interpretation, or live API test.

### 4.6 Jira connector

File: `src/connectors/jira.js`

Authentication is BYOT through:

```text
JIRA_BASE_URL
JIRA_EMAIL
JIRA_API_TOKEN
```

Configuration accepts `jql_scope`, defaulting to:

```text
assignee = currentUser() OR watcher = currentUser()
```

The cursor is keyed by that scope. The connector records `syncStartedAt` and constructs:

```text
(<scope>) AND updated >= "<cursor truncated to yyyy-MM-dd HH:mm>"
```

The first sync instead uses:

```text
(<scope>) AND updated >= -7d
```

It calls `/rest/api/3/search/jql` with:

```text
fields=summary,status,assignee,priority,labels,comment,issuelinks,description,updated
maxResults=100
nextPageToken=<when present>
```

Pagination continues until `nextPageToken` is absent. The cursor becomes the sync start time.

Normalized fields are:

```text
key, summary, status, assignee, priority, labels[],
description_adf, comment_count, last_comment_hash, links[]
```

Labels are sorted. Links retain `id`, type name, and inward or outward issue key, then sort by link ID.

The full ADF description is stored and handled by the ADF field differ. Comment bodies are not stored; only the latest returned comment body is JSON-stringified and hashed.

The connector does not use Jira’s upstream changelog bulk endpoint. It snapshot-diffs search results and has no retry, rate-limit handling, or live API test.

### 4.7 Provenance behavior

`ingestSnapshot()` chooses provenance in this order:

1. Lens-provided `provenanceUrl`.
2. Call-level `provenanceUrl`.
3. `object.url`.
4. `null`.

Current lenses do not define `provenanceUrl`, and live connectors do not pass an override. Current cards therefore link to the GitHub issue/PR or Jira issue, not the exact upstream field change, comment, changelog item, node, or endpoint revision.

### 4.8 what-changed CLI

Configuration is read from `what-changed.config.json` in the current working directory. The database path defaults to `what-changed.db` relative to that directory.

| Verb | Behavior |
|---|---|
| `sync` | Runs configured GitHub and Jira connectors, then GC. Requires a config file. |
| `report [--json] [--ack]` | Shows unmuted unseen deltas as cards; `--ack` marks displayed rows seen. |
| `diff <fileA> <fileB> [--json] [--format <id>]` | Ad-hoc block or data diff. |
| `mark-seen` | Marks every unseen database delta seen. |
| `mute <kind\|path\|object> <pattern>` | Adds a persistent mute. |
| `gc [--days N]` | Drops eligible aged payloads; default 30 days. |
| `demo` | Runs the in-memory Monday→Tuesday fixture scenario. |

Examples:

```bash
what-changed sync
what-changed report --json
what-changed report --ack
what-changed diff fixtures/openapi-v1.json fixtures/openapi-v2.json
what-changed mute kind comment
what-changed mute path /description_adf
what-changed mute object jira:PROJ-42
what-changed gc --days 14
what-changed demo
```

There is no `capture --label`, `watch`, `unwatch`, `report --since`, importance threshold, or `--only blockers|breakages` verb.

### 4.9 Tokenless demo

`what-changed demo` opens `:memory:`, ingests `fixtures/demo/monday.json`, marks Monday seen, ingests Tuesday, and renders the unseen digest.

The current fixture produces five Jira changes and three GitHub changes:

- Jira comments increased.
- Jira status changed.
- Jira ADF paragraph changed.
- Jira warning panel was removed.
- Jira priority increased.
- GitHub assignee was added.
- GitHub comments increased.
- GitHub PR became ready for review.

No model or API token is involved.

## 5. Status ledger

Legend:

- ✅ means the repository contains an automated test asserting the behavior.
- P1 means pitch integrity or baseline correctness: public/founding promises or correctness properties are not yet closed.
- P2 means breadth, distribution, hardening, or an implemented path that still lacks adequate automated verification.

This framework adds exact provenance, transactional ingestion, fingerprint completeness, promised noise controls, Merkle storage, and GitHub’s claimed upstream-native ingestion to P1. They are elevated because they affect the truthfulness or durability of the core “local delta engine” claim, not merely connector breadth.

### 5.1 read-better

| Feature | Status | Evidence or remaining work |
|---|---:|---|
| Canonical `id`/`idSource`/`hash` finalization | ✅ | `test/codec.test.js` verifies identity, metadata fingerprinting, and duplicate native IDs. |
| Content-derived identity stability | ✅ | ADF v1/v2 unchanged and edited blocks are compared. |
| Strict JSON before YAML | ✅ | `test/yaml.test.js`. |
| Markdown hint-gating and loud malformed JSON | ✅ | `test/markdown.test.js`, `test/codec.test.js`. |
| ADF bare document parsing/rendering | ✅ | `test/codec.test.js`. |
| Jira `fields.description` unwrapping | ✅ | `test/codec.test.js`. |
| Confluence ADF wrapper handling | P2 | Implemented but no Confluence-shaped test. |
| Full ADF node/mark matrix | P2 | Core nodes are tested; quote, ordinary lists, decisions, expands, media, dates, and unknown-node behavior need cases. |
| Markdown blocks and frontmatter | ✅ | `test/markdown.test.js`. |
| JSON/YAML outline and pointer access | ✅ | `test/outline.test.js`, `test/yaml.test.js`. |
| YAML strict-reject behavior | ✅ | Named rejection cases are tested. |
| A11y detection, blocks, and rendering | ✅ | `test/a11y.test.js`. |
| Figma native nodes and rendering | ✅ | `test/structured.test.js`. |
| OpenAPI JSON/YAML parsing and rendering | ✅ | `test/structured.test.js`. |
| Postman collection parsing | P2 | Implemented; no fixture or test. |
| Type-specific fingerprint completeness | ✅ | Batch 1 (2026-08-13): `canonicalStructure()` in fingerprint; six table-driven cases in `test/codec.test.js`, ids order-sensitive. Sol sign-off. |
| CLI facade | P2 | Implemented but has no automated CLI tests. |
| TypeScript declaration accuracy | P2 | Declarations exist but have no compile test. |
| README/CLI format status | ✅ | Batch 1: CLI help and README list the implemented seven formats; no stale “coming” claims. |
| npm test script | ✅ | Batch 1: `node --test test/*.test.js`; `npm test` verified in both repos. |
| npm publish readiness | P2 | Verify packed package/bin/types (pack/install smoke). |

### 5.2 what-changed core and current facades

| Feature | Status | Evidence or remaining work |
|---|---:|---|
| Recursive canonicalization | ✅ | `test/core.test.js`. |
| Generic add/remove/replace diff | ✅ | `test/core.test.js`. |
| Identity-keyed object-array diff | ✅ | Reorder stability tested in `test/core.test.js`. |
| Block add/remove/change/move | ✅ | `test/blockdiff.test.js`. |
| Same-native-ID/different-hash detection | ✅ | `test/blockdiff.test.js`. |
| Similarity re-pairing for content IDs | ✅ | ADF and Markdown edited blocks exercise it. |
| Native IDs never cross-paired | ✅ | Batch 2: adversarial test — different native ids, near-identical content → removed+added, never 'changed'. |
| Document/data routing and mixed refusal | ✅ | `test/diff-files.test.js`. |
| Content-addressed head no-op | ✅ | `test/core.test.js`. |
| First sightings and unseen baseline | ✅ | Fixture ingestion asserts three created rows. |
| Explicit `markSeen` baseline | ✅ | `test/core.test.js`. |
| Kind mute | ✅ | `test/core.test.js`. |
| Path and object mutes | P2 | Implemented but untested. |
| GC eligibility and hash retention | ✅ | `test/core.test.js`. |
| Jira ADF per-field differ | ✅ | Monday/Tuesday fixture asserts paragraph edit and panel removal. |
| Basic Jira/GitHub lens output | ✅ | Fixture test asserts Jira status/priority/content and GitHub ready transition. |
| Complete lens rule matrix | P2 | Add direct tests for every rule, suppression, decreases, removals, and sorted-array insertion behavior. |
| Fixture connector | ✅ | Used throughout `test/core.test.js`. |
| Change-card object contract | ✅ | Batch 2: exact key-set/type test incl. non-null `why_it_matters` (string, never the fact object). |
| Digest rendering | P2 | Demo works manually; add golden output coverage. |
| SQLite WAL | P2 | Enabled but not asserted. |
| Cursors | ✅ | Batch 4 (2026-08-15): unit round-trip/scoping/refresh + behavior proofs — start-time capture bracketed (t0 ≤ cursor ≤ handler-entered), failure never advances, second-sync since/JQL reuse. |
| Labeled snapshots / captured mode | ✅ | Batch 3 (2026-08-15): `capture --label` / `captures` / `diff --labels` (series model, {format, content} payloads, replayCapture, cross-format deltas owned by the format differ, collision-safe label migration + partial unique index, first-capture provenance). `test/capture.test.js`. |
| Transactional snapshot ingestion | ✅ | Batch 1 (2026-08-13): `BEGIN IMMEDIATE` with in-transaction head re-read, rollback + rethrow; two failure-point rollback tests in `test/core.test.js`. Sol sign-off. |
| Relevance engine | ✅ | Batch 2 (2026-08-13): `watches` fact table (per-source rows, read-time priority `ignored > dependency > assigned > manual > tracked`, ignored veto enforced in `unseenDeltas`), connector seeding from raw objects with no payload churn. `test/relevance.test.js`. Importance thresholds/usage learning remain P2. |
| Jira dependency edges | ✅ | Batch 2: `watch_edges (blocker, deriving_key)` with atomic per-deriving-key reconciliation; one-hop relevance-neutral blocker refetch (chunked `key in (…)`); shared-blocker survival tested. |
| `why_it_matters` | ✅ | Batch 2: cards emit the winning watch fact's reason; demo renders "↳ PROJ-51 is blocked by it"; non-null case in card-shape test. |
| Exact-change provenance | P1 | Cards link to object pages, not exact upstream changes. |
| Watch/unwatch and blocker filters | ✅ | Batch 2: `watch`/`unwatch` verbs (unwatch = persistent ignored veto; watch un-ignores), `report --only <kinds|blockers>` composing with `--ack`. Breakage filters remain P2 (need captured-mode runs). |
| Merkle/subtree hashes | P1 | `FOUNDING.md` promises `subtree_hashes`; no table or implementation exists. |
| `capture --label` CLI | ✅ | Batch 3 — see "Labeled snapshots / captured mode" row. Captured Playwright/Postman workflows in §5.3 now reduce to "run the tool, capture its output file". |
| Jira upstream changelog ingestion | P1 | Bulk changelog endpoint is promised; connector snapshot-diffs JQL search results. |
| GitHub upstream-native event ingestion | P1 | `FOUNDING.md` claims events/GraphQL; code polls REST issues and snapshot-diffs them. |
| Live API validation | P1 | Neither connector has been exercised by repository tests against a real API. |
| GitHub connector | ✅ | Batch 4: recorded-fixture behavior tests — Link pagination, DB-read payload golden (literal body_hash), auth/BYOT errors, buffered-pages failure semantics pinned (no partial ingest). Live validation still pending. |
| Jira connector | ✅ | Batch 4: recorded-fixture behavior tests — nextPageToken pagination, full-fields golden (literal last_comment_hash), JQL cursor reuse, page-by-page partial-ingest pinned, blocker `key in` query without `updated` clause. Live validation still pending. |
| `sync`, `report`, `mark-seen`, `mute`, `gc` CLI | P2 | Implemented; no CLI integration suite. |
| Tokenless demo | P2 | Runs successfully; add an automated digest golden. |
| README privacy claim | ✅ | Batch 1: README states per-source behavior precisely (Jira: latest-comment hash only, full ADF descriptions; GitHub: comment count only, body hash). `store_content` knob remains P2. |
| Idempotent/safe connector loop proof | ✅ (recorded) | Batch 4: failure semantics pinned per connector; cursor never advances on failure; content-addressing makes re-sync no-ops. Retry/backoff itself remains P2 (unbuilt); live failure tests await a PAT. |

### 5.3 Remaining breadth and distribution

| Feature | Priority | Required result |
|---|---:|---|
| Confluence connector | P2 | Cursor-paginated tracked pages and historical ADF body comparison. |
| Salesforce connector | P2 | Service Cloud Cases first; Connected App plus OAuth device flow. |
| Tracked Figma connector | P2 | File/version acquisition, node/version provenance, and cursor strategy. |
| Captured Playwright workflow | P2 | Named a11y snapshots; optional screenshot evidence. |
| Captured Postman/OpenAPI workflow | P2 | Named spec/run-report snapshots and run-result comparison. |
| Recorded-API-fixture connector tests | ✅ | Batch 4: `fixtures/recorded/` + `test/helpers/recorded.js` stub + `test/connectors.test.js` (11 tests). Retry fixtures deferred with the retry feature (P2). |
| CI workflows | P2 | Supported Node matrix, test, demo smoke, package validation. |
| npm publish preparation | P2 | Repair scripts, remove stale `../adf-codec` lock entry, pack/install smoke tests, metadata review. |
| MCP facade | P2 | `what_changed(scope, since)` and `diff(a, b)` over the same core/cards. |
| Dashboard | P2 | Read the same SQLite store and present unseen cards. |
| Redaction knobs / `store_content` | P2 | Configurable pre-write retention of descriptions, comments, customer data, and oversized bodies. |
| Rate-limit handling and backoff | P2 | Respect provider signals, retry transient failures, and preserve cursor safety. |
| Usage learning | P2 | Decay/rank-up behavior after deterministic relevance proves reliable. |
| Slack delivery | P2 | Digest delivery only; not a source of truth. |
| Demo GIF | P2 | Record the tokenless overnight scenario and provenance flow. |
| OS keychain auth | P2 | FOUNDING promises pasted-token storage; implementation currently reads environment variables only. |
| API-impact semantics | P2 | Add “breaking change” classification beyond structural endpoint summaries. |

## 6. Verification map

### 6.1 Test counts and commands

The repositories define:

```text
read-better:  27 tests across 6 files
what-changed: 17 tests across 3 files
```

Use explicit file globs:

```bash
cd /Users/tashfeenmahmud/Projects/src/read-better
node --test test/*.test.js

cd /Users/tashfeenmahmud/Projects/src/what-changed
node --test test/*.test.js
```

The package scripts originally used `node --test test/`, which Node.js v25 treats as a module path — both `npm test` commands failed before discovering the suites. **Fixed in Batch 1** (`node --test test/*.test.js`); `npm test` now discovers and passes both suites (27 read-better / 19 what-changed after Batch 1's added tests).

Audit execution results:

- `read-better`: 27/27 passed with the explicit glob.
- `what-changed`: 17 tests discovered; 15 passed inside Sol's read-only
  audit sandbox. The two remaining cases (JSON and YAML data routing in
  `test/diff-files.test.js`) were blocked before assertions because that
  sandbox denies `mkdtempSync()` in the system temp directory — **reviewer
  note (Claud): all 17/17 pass in a normal environment**, verified in the
  working session on 2026-08-13.
- `what-changed demo` executed successfully using the in-memory database.

### 6.2 Test-file ownership

| Test file | Claims covered |
|---|---|
| `read-better/test/codec.test.js` | ADF blocks, inline marks, Jira wrapper, compact render, JSON fallback, malformed JSON, ID/hash contract. |
| `read-better/test/markdown.test.js` | Hint-gating, block shapes, task/table parsing, frontmatter, shared rendering. |
| `read-better/test/outline.test.js` | Shape-only output, scan cap, optional keys, domains, samples, RFC 6901 access/errors. |
| `read-better/test/structured.test.js` | Figma native identity/tree render; OpenAPI JSON/YAML detection, metadata, render. |
| `read-better/test/a11y.test.js` | A11y YAML detection, role/depth/children metadata, generic-YAML refusal, tree render. |
| `read-better/test/yaml.test.js` | Maps, sequences, typing, strings, comments, block scalars, flow collections, named rejections, JSON precedence. |
| `what-changed/test/blockdiff.test.js` | Block edits/adds/removes, no-op, native hash change, same-hash stability, LCS moves. |
| `what-changed/test/core.test.js` | Canonicalization, JSON diff, identity arrays, content no-op, lenses, seen baseline, kind mute, ADF field differ, GC. |
| `what-changed/test/diff-files.test.js` | Markdown/Figma/OpenAPI golden diffs, document/data routing, mixed-format refusal, YAML value diff. |

There are no automated tests for live connector fetching, pagination, cursors, cards, digest rendering, CLI argument handling, labels, path/object mutes, or `snapshotByLabel()`.

### 6.3 Fixture golden pairs

| Pair | Expected proof |
|---|---|
| `what-changed/fixtures/release-notes-v1.json` → `release-notes-v2.json` | ADF panel removal, code edit, task progress, table growth, section addition. |
| `what-changed/fixtures/notes-v1.md` → `notes-v2.md` | Equivalent Markdown block-level changes. |
| `what-changed/fixtures/figma-file-v1.json` → `figma-file-v2.json` | Native-ID text edit, parent child-count change, new `TrustBadge` instance. |
| `what-changed/fixtures/openapi-v1.json` → `openapi-v2.json` | API version heading change, required `role` parameter, endpoint removal/addition. |
| `what-changed/fixtures/demo/monday.json` → `demo/tuesday.json` | Cross-connector store, lens, ADF differ, seen-baseline, and digest scenario. |
| `read-better/fixtures/release-notes-v1.json` → `release-notes-v2.json` | Content-derived identity stability across unchanged and edited ADF blocks. |

Tokenless product check:

```bash
cd /Users/tashfeenmahmud/Projects/src/what-changed
node src/cli.js demo
```

Ad-hoc format checks:

```bash
node src/cli.js diff fixtures/figma-file-v1.json fixtures/figma-file-v2.json
node src/cli.js diff fixtures/openapi-v1.json fixtures/openapi-v2.json
node src/cli.js diff fixtures/notes-v1.md fixtures/notes-v2.md
```

## 7. Working model

Implementation is done by Codex Terra (`gpt-5.6-terra`, medium reasoning). Reviews are signed off by Codex Sol (`xhigh`). Claud (`Fable 5`) orchestrates and serves as secondary reviewer. Tashfeen owns scope and naming.
