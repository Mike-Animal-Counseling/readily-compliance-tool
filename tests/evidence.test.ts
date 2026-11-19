import assert from "node:assert/strict";
import { test } from "node:test";
import { readAssessment } from "../lib/evidence/assessment";
import { parsePolicy } from "../lib/evidence/layout";
import { makeChildren } from "../lib/evidence/model";
import type { EvidenceUnit, ParentBlock } from "../lib/evidence/model";
import { parentBatches, rankParents } from "../lib/evidence/parents";
import type { ChildHit } from "../lib/evidence/parents";
import { pdfGrid, pdfLines, synthPdf } from "./fixtures/policy-pdf";

test("rank by best child, retaining three hits with distinct version and parent identities", () => {
  const hit = (documentVersionId: string, parentId: string, childId: string, score: number): ChildHit =>
    ({ documentVersionId, parentId, childId, score, unitIds: [childId + "-unit"] });
  const matches = rankParents([
    hit("v1", "p1", "c1", 9), hit("v1", "p1", "c2", 8), hit("v1", "p1", "c3", 7),
    hit("v2", "p1", "c1", 6), hit("v1", "p2", "c1", 5), hit("v3", "p1", "c1", 4),
  ], 3);
  assert.deepEqual(matches.map(parent => [parent.documentVersionId, parent.parentId, parent.score]), [
    ["v1", "p1", 9], ["v2", "p1", 6], ["v1", "p2", 5],
  ]);
  assert.deepEqual(matches[0].hits.map(item => item.unitIds[0]), ["c1-unit", "c2-unit", "c3-unit"]);
});

test("bounded PDF worker preserves nested clauses, cross-page table rows and source rectangles", async () => {
  const parsed = await parsePolicy(synthPdf([
    pdfLines(["Section 4. Retention", "4.1 Keep receipts for ten days.", "4.1.1 Follow section 7.1 unless waived."])
      + "\n" + pdfGrid([["Item", "Treatment"], ["Receipts", "Keep ten days"]], 625),
    pdfGrid([["Item", "Treatment"], ["Transfers", "Keep twenty days"]], 745)
      + "\n" + pdfLines(["Section 7.1 Waivers", "Written waivers require two reviewers."], 650),
  ]));
  assert.equal(parsed.parents.length, 2);
  assert.deepEqual(parsed.warnings, []);
  const units = parsed.parents[0].units;
  assert.equal(units.find(unit => unit.clause === "4.1.1")?.exception, true);
  assert.deepEqual(units.find(unit => unit.clause === "4.1.1")?.references, ["7.1"]);
  const rows = units.filter(unit => unit.table);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(unit => unit.table?.id)).size, 1);
  assert.deepEqual(rows[3].table?.cells.map(cell => cell.text), ["Transfers", "Keep twenty days"]);
  assert.equal(rows[3].table?.cells[1].box.page, 2);
  assert.ok(rows[3].table!.cells[1].box.right > rows[3].table!.cells[1].box.left);
});

test("scan without a text layer is flagged", async () => {
  const parsed = await parsePolicy(synthPdf([pdfLines(["Section 1. Readable"]), "1 w 40 40 m 60 60 l S"]));
  assert.deepEqual(parsed.warnings, [{ page: 2, code: "unreadable_page" }]);
});

test("long parents are read through the final exception with table headers in later batches", () => {
  const unit = (index: number, properties: Partial<EvidenceUnit> = {}): EvidenceUnit => ({
    id: `u${index}`, clause: "4.1", kind: "paragraph", boxes: [], text: "Control statement. ".repeat(44),
    exception: false, references: [], ...properties,
  });
  const header = unit(8, { text: "Item | Treatment", table: { id: "t1", row: 1, header: true, cells: [] } });
  const last = unit(20, { text: "Unless waived: get two reviewers.", exception: true });
  const block: ParentBlock = {
    id: "p1",
    units: [
      ...Array.from({ length: 8 }, (_, i) => unit(i)), header,
      ...Array.from({ length: 10 }, (_, i) => unit(i + 9, { table: { id: "t1", row: i + 2, header: false, cells: [] } })),
      last,
    ],
  };
  const children = makeChildren(block);
  assert.ok(children.length >= 3);
  assert.deepEqual(children.flatMap(child => child.unitIds), block.units.map(item => item.id));
  const batches = parentBatches(block, 2000);
  assert.deepEqual([...new Set(batches.flatMap(batch => batch.map(item => item.id)))], block.units.map(item => item.id));
  assert.ok(batches.filter(batch => batch.some(item => item.table)).every(batch => batch.includes(header)));
  const result = readAssessment("What does section 4.1 state?", [{
    block, documentVersionId: "v1", parentId: "p1", hits: [], score: 1,
  }], ["unresolved_clause_reference"]);
  assert.ok(result.batchesRead > 1);
  assert.equal(result.status, "needs_review");
  assert.ok(result.reasons.includes("unresolved_clause_reference"));
  assert.equal(result.exceptions[0].unitId, last.id);
});
