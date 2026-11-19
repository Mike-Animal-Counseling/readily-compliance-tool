import type { EvidenceUnit, ParentBlock } from "./model";

type Identity = { documentVersionId: string; parentId: string };
export type ChildHit = Identity & { childId: string; unitIds: string[]; score: number };
export type ParentMatch = Identity & { score: number; hits: ChildHit[] };
export type ReadParent = ParentMatch & { block: ParentBlock };

export function parentKey({ documentVersionId, parentId }: Identity) {
  return `${documentVersionId}/${parentId}`;
}

// Candidates have already been scoped to one tenant and snapshot.
export function rankParents(candidates: ChildHit[], topK: number): ParentMatch[] {
  const byParent = new Map<string, ParentMatch>();
  const ranked = [...candidates].sort((a, b) => b.score - a.score ||
    parentKey(a).localeCompare(parentKey(b)) || a.childId.localeCompare(b.childId));
  for (const hit of ranked) {
    const key = parentKey(hit);
    let parent = byParent.get(key);
    if (!parent) {
      parent = { documentVersionId: hit.documentVersionId, parentId: hit.parentId, score: hit.score, hits: [] };
      byParent.set(key, parent);
    }
    parent.hits.push(hit);
  }
  return [...byParent.values()].slice(0, topK);
}

export function parentBatches(block: ParentBlock, maxCharacters = 8000): EvidenceUnit[][] {
  const batches: EvidenceUnit[][] = [];
  const headers = new Map<string, EvidenceUnit>();
  let batch: EvidenceUnit[] = [];
  let length = 0;
  for (const unit of block.units) {
    const size = unit.text.length + 96;
    if (unit.table?.header) headers.set(unit.table.id, unit);
    const header = unit.table && !unit.table.header ? headers.get(unit.table.id) : undefined;
    const headerSize = header ? header.text.length + 96 : 0;
    if (batch.length && length + size + (header && !batch.includes(header) ? headerSize : 0) > maxCharacters) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    if (header && !batch.includes(header)) {
      batch.push(header);
      length += headerSize;
    }
    batch.push(unit);
    length += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
