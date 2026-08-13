// Block-level diff over read-better's canonical blocks: added / removed /
// changed / moved. Format knowledge lives in the codec (block types, labels,
// stable IDs); this file is pure comparison — identity matching, similarity
// re-pairing of edits, LCS move detection. Moved here from the codec repo:
// reading is read-better's job, answering "what changed?" is ours.
import { contentOf, labelOf } from 'read-better';

/**
 * Diff two canonical block arrays.
 * Returns ops: { op: 'added'|'removed'|'changed'|'moved', type, label,
 *                before?, after?, summary }.
 */
export function blockDiff(blocksA, blocksB) {
  const idsA = new Map(blocksA.map((blk, i) => [blk.id, { blk, i }]));
  const idsB = new Map(blocksB.map((blk, i) => [blk.id, { blk, i }]));

  let removed = blocksA.filter((blk) => !idsB.has(blk.id));
  let added = blocksB.filter((blk) => !idsA.has(blk.id));
  const ops = [];

  // Pair up edits: same type, most-similar content above threshold.
  for (const oldBlock of [...removed]) {
    let best = null;
    for (const newBlock of added) {
      if (newBlock.type !== oldBlock.type) continue;
      const score = similarity(contentOf(oldBlock), contentOf(newBlock));
      if (score >= 0.4 && (!best || score > best.score)) best = { newBlock, score };
    }
    if (best) {
      ops.push({
        op: 'changed',
        type: oldBlock.type,
        label: labelOf(best.newBlock),
        before: contentOf(oldBlock),
        after: contentOf(best.newBlock),
        summary: changeSummary(oldBlock, best.newBlock),
      });
      removed = removed.filter((blk) => blk !== oldBlock);
      added = added.filter((blk) => blk !== best.newBlock);
    }
  }

  for (const blk of removed) {
    ops.push({ op: 'removed', type: blk.type, label: labelOf(blk), before: contentOf(blk),
      summary: `${labelOf(blk)} removed` });
  }
  for (const blk of added) {
    ops.push({ op: 'added', type: blk.type, label: labelOf(blk), after: contentOf(blk),
      summary: `${labelOf(blk)} added` });
  }

  // Moves: ids present in both docs whose relative order broke. Blocks on the
  // longest common subsequence of shared ids kept their order; the rest moved.
  const sharedA = blocksA.filter((blk) => idsB.has(blk.id)).map((blk) => blk.id);
  const sharedB = blocksB.filter((blk) => idsA.has(blk.id)).map((blk) => blk.id);
  const stable = new Set(lcs(sharedA, sharedB));
  for (const id of sharedB) {
    if (!stable.has(id)) {
      const { blk } = idsB.get(id);
      ops.push({ op: 'moved', type: blk.type, label: labelOf(blk), summary: `${labelOf(blk)} moved` });
    }
  }

  return ops;
}

function changeSummary(oldBlock, newBlock) {
  if (oldBlock.type === 'heading' && oldBlock.text !== newBlock.text) {
    return `section retitled: "${oldBlock.text}" → "${newBlock.text}"`;
  }
  if (oldBlock.type === 'tasks') {
    const doneBefore = oldBlock.items.filter((t) => t.state === 'done').length;
    const doneAfter = newBlock.items.filter((t) => t.state === 'done').length;
    if (newBlock.items.length !== oldBlock.items.length) {
      return `task list: ${oldBlock.items.length} → ${newBlock.items.length} tasks`;
    }
    if (doneAfter !== doneBefore) {
      return `task list: ${doneAfter}/${newBlock.items.length} done (was ${doneBefore})`;
    }
  }
  if (oldBlock.type === 'list' && newBlock.items.length !== oldBlock.items.length) {
    return `${labelOf(newBlock)}: ${oldBlock.items.length} → ${newBlock.items.length} items`;
  }
  if (oldBlock.type === 'table' && newBlock.rows.length !== oldBlock.rows.length) {
    return `table: ${oldBlock.rows.length} → ${newBlock.rows.length} rows`;
  }
  return `${labelOf(newBlock)} edited`;
}

/** Word-set Jaccard similarity — cheap and good enough to pair edits. */
function similarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!setA.size && !setB.size) return 1;
  let overlap = 0;
  for (const word of setA) if (setB.has(word)) overlap += 1;
  return overlap / (setA.size + setB.size - overlap);
}

function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = a.length, j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return out;
}
