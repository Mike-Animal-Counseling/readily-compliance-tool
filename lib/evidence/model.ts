export const parserVersion = "pdf2json-layout-v1";
export const embeddingVersion = "hash-128-v1";
export const indexVersion = "exact-fts-vector-rrf-v1";

// Rectangles are normalized to the page, measured from its top left.
export type SourceBox = { page: number; left: number; top: number; right: number; bottom: number };

export type EvidenceCell = { column: number; text: string; box: SourceBox };

export type EvidenceUnit = {
  id: string;
  kind: "clause" | "paragraph" | "table_row";
  text: string;
  boxes: SourceBox[];
  clause: string | null;
  references: string[];
  exception: boolean;
  table?: { id: string; row: number; header: boolean; cells: EvidenceCell[] };
};

export type ParentBlock = { id: string; units: EvidenceUnit[] };
export type ParseWarning = { page: number; code: "unreadable_page" | "uncertain_layout" };
export type ParsedPolicy = { parents: ParentBlock[]; warnings: ParseWarning[]; pageCount: number };

export type ChildBlock = {
  id: string;
  parentId: string;
  unitIds: string[];
  text: string;
  clauses: string[];
};

export function makeChildren(parent: ParentBlock): ChildBlock[] {
  const children: ChildBlock[] = [];
  let units: EvidenceUnit[] = [];
  let length = 0;
  const flush = () => {
    if (!units.length) return;
    children.push({
      id: `${parent.id}-c${children.length + 1}`,
      parentId: parent.id,
      unitIds: units.map(unit => unit.id),
      text: units.map(unit => unit.text).join("\n"),
      clauses: [...new Set(units.flatMap(unit => unit.clause ? [unit.clause] : []))],
    });
    units = [];
    length = 0;
  };
  for (const unit of parent.units) {
    if (length && (length + unit.text.length > 2400 || (length >= 1200 && unit.kind === "clause"))) flush();
    units.push(unit);
    length += unit.text.length + 1;
  }
  flush();
  return children;
}
