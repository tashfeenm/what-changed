// Semantic lenses: path→meaning tables. Data, not code — each rule maps a
// JSON-pointer pattern from the generic diff to a delta kind and a human
// sentence. The generic diff is table stakes; this layer is the product.

/**
 * Build a lens function from rules: [{ pattern: RegExp, kind, summary(op, payload) }].
 * First matching rule wins; return null to fall through to the generic summary.
 */
export function makeLens(rules) {
  return (op, payload) => {
    for (const rule of rules) {
      if (rule.pattern.test(op.path)) {
        if (rule.suppress) return { suppress: true }; // bookkeeping field, never news
        const summary = typeof rule.summary === 'function' ? rule.summary(op, payload) : rule.summary;
        if (summary) return { kind: rule.kind, summary, provenanceUrl: rule.provenanceUrl?.(op, payload) };
      }
    }
    return null;
  };
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '(none)' : JSON.stringify(v));

export const githubLens = makeLens([
  { pattern: /^\/state$/, kind: 'status', summary: (op) => `state: ${str(op.before)} → ${str(op.after)}` },
  { pattern: /^\/title$/, kind: 'field', summary: (op) => `retitled: “${str(op.before)}” → “${str(op.after)}”` },
  { pattern: /^\/assignees\b/, kind: 'field',
    summary: (op) => op.op === 'add' ? `assigned: ${str(op.after)}` : op.op === 'remove' ? `unassigned: ${str(op.before)}` : `assignee changed: ${str(op.before)} → ${str(op.after)}` },
  { pattern: /^\/labels\b/, kind: 'field',
    summary: (op) => op.op === 'add' ? `label added: ${str(op.after)}` : op.op === 'remove' ? `label removed: ${str(op.before)}` : null },
  { pattern: /^\/comments$/, kind: 'comment',
    summary: (op) => (op.after > op.before ? `${op.after - op.before} new comment${op.after - op.before > 1 ? 's' : ''}` : null) },
  { pattern: /^\/draft$/, kind: 'status', summary: (op) => (op.after === false ? 'marked ready for review' : 'converted to draft') },
  { pattern: /^\/merged$/, kind: 'status', summary: (op) => (op.after ? 'merged' : null) },
  { pattern: /^\/body_hash$/, kind: 'field', summary: () => 'description edited' },
  { pattern: /^\/updated_at$/, suppress: true },
]);

export const jiraLens = makeLens([
  { pattern: /^\/status$/, kind: 'status', summary: (op) => `status: ${str(op.before)} → ${str(op.after)}` },
  { pattern: /^\/assignee$/, kind: 'field', summary: (op) => `assignee: ${str(op.before)} → ${str(op.after)}` },
  { pattern: /^\/priority$/, kind: 'field', summary: (op) => `priority: ${str(op.before)} → ${str(op.after)}` },
  { pattern: /^\/summary$/, kind: 'field', summary: (op) => `retitled: “${str(op.before)}” → “${str(op.after)}”` },
  { pattern: /^\/comment_count$/, kind: 'comment',
    summary: (op) => (op.after > op.before ? `${op.after - op.before} new comment${op.after - op.before > 1 ? 's' : ''}` : null) },
  { pattern: /^\/labels\b/, kind: 'field',
    summary: (op) => op.op === 'add' ? `label added: ${str(op.after)}` : op.op === 'remove' ? `label removed: ${str(op.before)}` : null },
  { pattern: /^\/links\b/, kind: 'field',
    summary: (op) => op.op === 'add' ? `link added: ${str(op.after?.type)} ${str(op.after?.key)}` : null },
  // comment_count already reports new comments; the hash alone (an edit) is
  // below the noise floor for v0.1.
  { pattern: /^\/last_comment_hash$/, suppress: true },
]);

