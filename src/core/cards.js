// Change cards: the universal delta object every facade speaks (FOUNDING.md §7).

export function toCard(row, { whyIndex = null } = {}) {
  const objectLabel = row.object_name ?? row.external_id;
  const fact = whyIndex?.get(row.object_id);
  return {
    what: `${objectLabel}: ${row.summary}`,
    // Relevance is a structured fact in the index; cards deliberately expose
    // only its human-facing reason. Passing the fact itself produces the
    // unhelpful "[object Object]" in text renderers.
    why_it_matters: fact?.reason ?? null,
    source: row.connector,
    kind: row.kind,
    object: `${row.connector}:${row.external_id}`,
    confidence: 'high', // structural diffs are exact; lens phrasing may vary
    provenance_url: row.provenance_url ?? row.object_url ?? null,
    observed_at: row.observed_at,
    delta_id: row.id,
    actions: ['open', 'mark_seen', 'mute_kind', 'unwatch'],
  };
}

const KIND_TAGS = {
  status: 'STATUS', comment: 'COMMENT', created: 'NEW', field: 'FIELD',
  content: 'DOC', node: 'NODE', route: 'ROUTE', endpoint: 'ENDPOINT', removed: 'GONE',
};

export function renderCard(card) {
  const tag = KIND_TAGS[card.kind] ?? card.kind.toUpperCase();
  const lines = [`  [${tag}] ${card.what}`];
  if (card.why_it_matters) lines.push(`      ↳ ${card.why_it_matters}`);
  if (card.provenance_url) lines.push(`      ${card.provenance_url}`);
  return lines.join('\n');
}

export function renderDigest(cards) {
  if (!cards.length) return 'Nothing changed since you last looked.';
  const bySource = new Map();
  for (const card of cards) {
    if (!bySource.has(card.source)) bySource.set(card.source, []);
    bySource.get(card.source).push(card);
  }
  const parts = [];
  for (const [source, group] of bySource) {
    parts.push(`\n${source} — ${group.length} change${group.length > 1 ? 's' : ''}`);
    for (const card of group) parts.push(renderCard(card));
  }
  return parts.join('\n').trim();
}
