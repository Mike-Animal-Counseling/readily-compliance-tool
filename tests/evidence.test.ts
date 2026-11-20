import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { readAssessment } from "../lib/evidence/assessment";
import { evidenceDb } from "../lib/evidence/connection";
import { parsePolicy } from "../lib/evidence/layout";
import { makeChildren } from "../lib/evidence/model";
import type { EvidenceUnit, ParentBlock } from "../lib/evidence/model";
import { parentBatches, rankParents } from "../lib/evidence/parents";
import type { ChildHit } from "../lib/evidence/parents";
import { pdfGrid, pdfLines, synthPdf } from "./fixtures/policy-pdf";

test("production evidence requires database certificate and hostname verification", () => {
  const env: Record<string, string | undefined> = process.env;
  const previous = { NODE_ENV: env.NODE_ENV, READILY_V1_DATABASE_URL: env.READILY_V1_DATABASE_URL };
  try {
    env.NODE_ENV = "production";
    env.READILY_V1_DATABASE_URL = "postgresql://localhost/disposable?sslmode=require";
    assert.throws(evidenceDb, /requires verified TLS/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});

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
  const box = rows[3].table!.cells[1].box;
  assert.ok(Math.abs(box.left - 240 / 612) < 0.001);
  assert.ok(Math.abs(box.right - 540 / 612) < 0.001);
  assert.ok(Math.abs(box.top - (792 - 721) / 792) < 0.001);
});

test("scan without a text layer is flagged", async () => {
  const parsed = await parsePolicy(synthPdf([pdfLines(["Section 1. Readable"]), "1 w 40 40 m 60 60 l S"]));
  assert.deepEqual(parsed.warnings, [{ page: 2, code: "unreadable_page" }]);
});

test("same-host OCR fills only unreadable pages and preserves review and cell locations", async () => {
  const env = process.env;
  const previous = { READILY_V1_OCR_PORT: env.READILY_V1_OCR_PORT, READILY_V1_OCR_TOKEN: env.READILY_V1_OCR_TOKEN };
  const token = randomBytes(32).toString("base64url");
  const fixture = synthPdf([pdfLines(["Section 1. Native clause"]), "1 w 40 40 m 60 60 l S"]);
  let pdfReceived = Buffer.alloc(0);
  const box = { page: 2, left: 0.1, top: 0.2, right: 0.5, bottom: 0.3 };
  const pages = [[{ text: "Alternate text for readable page", boxes: [{ ...box, page: 1 }] }], [
    { text: "Section 2. Scanned policy", boxes: [box] },
    {
      text: "Unless waived | 20 days", boxes: [box],
      table: { id: "ocr-t1", row: 1, header: false, cells: [{ column: 2, text: "20 days", box }] },
    },
  ]];
  const server = createServer((request, response) => {
    if (request.url !== "/parse" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      pdfReceived = Buffer.concat(chunks);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ version: "docling-2.151.1-layout-v1", pages }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  env.READILY_V1_OCR_PORT = String((server.address() as AddressInfo).port);
  env.READILY_V1_OCR_TOKEN = token;
  try {
    const result = await parsePolicy(fixture);
    assert.deepEqual(pdfReceived, fixture);
    assert.match(result.parserVersion, /docling/);
    assert.deepEqual(result.warnings, [{ page: 2, code: "uncertain_layout" }]);
    const units = result.parents.flatMap(parent => parent.units);
    assert.ok(units.some(unit => unit.text.includes("Native clause")));
    assert.ok(units.every(unit => !unit.text.includes("Alternate text")));
    assert.equal(units.find(unit => unit.table)?.exception, true);
    assert.deepEqual(units.find(unit => unit.table)?.table?.cells[0], { column: 2, text: "20 days", box });

    box.page = 1;
    const invalid = await parsePolicy(fixture);
    assert.equal(invalid.parserVersion, "pdf2json-layout-v1");
    assert.deepEqual(invalid.warnings, [{ page: 2, code: "unreadable_page" }]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("exact table quotations cite each nonempty cell at its own column", async () => {
  const parsed = await parsePolicy(synthPdf([pdfLines(["Section 4.1 Retention schedule"])
    + "\n" + pdfGrid([["Record", "Minimum period"], ["Ledger", "20 days"]], 690)]));
  const [block] = parsed.parents;
  const result = readAssessment("Quote section 4.1", [{
    documentVersionId: "synthetic-version", parentId: block.id, score: 1, hits: [], block,
  }], []);
  assert.equal(result.status, "supported");
  const row = result.claims.find(claim => claim.statement === "Ledger | 20 days");
  assert.deepEqual(row?.evidence.map(({ quote, column }) => [quote, column]), [["Ledger", 1], ["20 days", 2]]);
  assert.equal(row?.evidence[0].unitId, row?.evidence[1].unitId);
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
