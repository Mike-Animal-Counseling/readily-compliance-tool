import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { ApiError, createClient } from "../examples/readily-v1/client";
import type { Report } from "../examples/readily-v1/client";
import type { ParentBlock } from "../lib/evidence/model";
import { benchmark } from "../tests/evidence-benchmark";
import { pdfGrid, pdfLines, synthPdf } from "../tests/fixtures/policy-pdf";

const database = process.env.READILY_V1_TEST_DATABASE_URL;
if (!database) throw new Error("Set READILY_V1_TEST_DATABASE_URL to a disposable local PostgreSQL database");
const url = new URL(database);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/readily_v1_test");
const sql = postgres(database, { max: 1, connect_timeout: 5, onnotice: () => {} });
const origin = "http://127.0.0.1:3011";
const tenantIds: string[] = [];
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const expectedError = (status: number, code?: string) => (error: unknown) =>
  error instanceof ApiError && error.status === status && (!code || code === error.code);
const runFile = promisify(execFile);

async function newTenant(scopes = ["read", "ingest", "evaluate", "review", "index"]) {
  const id = randomUUID();
  const token = "rdy_" + randomBytes(32).toString("base64url");
  await sql.begin(async tx => {
    await tx`insert into readily_v1.tenants (id, enabled) values (${id}, true)`;
    await tx`insert into readily_v1.api_keys (digest, tenant_id, label, scopes, expires_at)
      values (${sha(token)}, ${id}, 'synthetic-test', ${tx.array(scopes)}, now() + interval '1 hour')`;
  });
  tenantIds.push(id);
  return { id, token, client: createClient(origin, token) };
}

function versionPdf(marker: string) {
  const rows = Array.from({ length: 20 }, (_, index) =>
    `Control ${index + 1}: retain the manifest and review the documented checkpoint with the lead.`);
  return synthPdf([
    pdfLines(["Section 4.1 Dispatch", `Dispatch inventory uses ${marker} tags.`, ...rows]),
    pdfLines(["Section 4.1 Dispatch", ...rows]),
    pdfLines(["Section 4.1 Dispatch", ...rows, "Unless waived under section 99.7, retain the final entry."]),
    pdfLines(["Section 7.1 Inventory", "Reconcile stock counts."]) + "\n" + pdfGrid([["Item", "Quantity"], ["Seal", "Twelve"]], 655),
  ]);
}

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3011", "-H", "127.0.0.1"], {
  env: { ...process.env, NODE_ENV: "development", APP_ORIGIN: origin, REDIS_URL: "",
    DEMO_ACCESS_CODE: randomBytes(32).toString("hex"), SESSION_SECRET: randomBytes(32).toString("hex"),
    OPENROUTER_API_KEY: "", READILY_V1_ENABLED: "true", READILY_V1_DATABASE_URL: database },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream?.on("data", progress => { logs = (logs + String(progress)).slice(-6000); });

async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(origin + "/api/v1/snapshots/active", { signal: AbortSignal.timeout(3000) });
      if (response.status === 401) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Local Next.js API did not start\n" + logs);
}

try {
  const [schema] = await sql`select to_regclass('readily_v1.reviews') is not null as migrated`;
  if (!schema.migrated) {
    for (const name of ["001_versioned_evidence.sql", "002_review_answers.sql"]) {
      await sql.unsafe(await readFile(join("db", "migrations", name), "utf8"));
    }
  }
  await ready();
  const { client } = await newTenant();
  const other = (await newTenant()).client;
  const readOnly = (await newTenant(["read"])).client;
  await assert.rejects(readOnly.evaluate("Check scope", "scope"), expectedError(403, "scope_required"));
  const original = versionPdf("indigo");
  const metadata = { documentKey: "dispatch", fileName: "synthetic.pdf", effectiveFrom: "2020-01-01" };
  const first = await client.upload(original, metadata, "upload");
  assert.equal((await client.upload(original, metadata, "upload")).id, first.id);
  await assert.rejects(client.upload(original, { ...metadata, documentKey: "different" }, "upload"),
    expectedError(409, "idempotency_conflict"));
  await assert.rejects(other.request(`/documents/${first.id}/source`), expectedError(404));
  await assert.rejects(other.index([first.id], "index"), expectedError(404));

  const a = await client.index([first.id], "build-a");
  await client.activate(a.id, null, "activate-a");
  await assert.rejects(other.activate(a.id, null, "foreign-activate"), expectedError(404));
  const question = "What does section 4.1 state?";
  const [old, replay] = await Promise.all([
    client.evaluate(question, "parallel-eval", "2024-01-01"),
    client.evaluate(question, "parallel-eval", "2024-01-01"),
  ]);
  assert.equal(replay.id, old.id);
  const matches = old.result.parents.filter(parent => parent.parentId === "p1");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].hits.length, 3);
  assert.equal(new Set(matches[0].hits.flatMap(hit => hit.unitIds)).size, matches[0].hits.flatMap(hit => hit.unitIds).length);
  assert.equal(old.result.status, "needs_review");
  assert.ok(old.result.batchesRead > 1);
  assert.ok(old.result.reasons.includes("unresolved_clause_reference"));
  const firstEvidence = old.result.excerpts.find(item => item.quote.includes("indigo"));
  assert.ok(firstEvidence);
  const evidencePath = `/reports/${old.id}/evidence/${first.id}/p1`;
  const initialLocation = await client.locate(old.id, firstEvidence);
  assert.equal(initialLocation.unit.boxes[0].page, 1);
  const complete = await client.json<{ block: ParentBlock }>(evidencePath);
  assert.ok(complete.block.units.at(-1)?.text.includes("99.7"));
  assert.ok(complete.block.units.some(item => item.boxes.some(box => box.page === 3)));
  assert.equal(old.result.exceptions.length, 1);
  assert.ok(old.result.exceptions[0].quote.includes("retain the final entry"));
  await assert.rejects(other.report(old.id), expectedError(404));
  await assert.rejects(other.request(evidencePath), expectedError(404));
  await assert.rejects(other.review(old.id, { state: "approved", notes: "invalid tenant", expectedRevision: null }, "foreign-review"),
    expectedError(404));

  const reviewInput = { state: "approved", notes: "Synthetic reviewer checked the exception manually.",
    expectedRevision: null, answerOverride: "Synthetic approved answer." } as const;
  const review = await client.review(old.id, reviewInput, "review");
  assert.equal((await client.review(old.id, reviewInput, "review")).revision, review.revision);
  await assert.rejects(client.review(old.id, reviewInput, "stale-review"), expectedError(409, "review_revision_changed"));
  assert.equal((await client.report(old.id)).reviewState, "approved");
  const history = await client.json<{ items: { answerOverride: string }[] }>(`/reports/${old.id}/reviews`);
  assert.equal(history.items[0].answerOverride, reviewInput.answerOverride);

  const second = await client.upload(versionPdf("amber"), { ...metadata, effectiveFrom: "2023-01-01" }, "upload-b");
  const [b, duringBuild] = await Promise.all([
    client.index([second.id], "build-b"),
    client.evaluate(question, "during-build", "2024-01-01"),
  ]);
  assert.equal(duringBuild.snapshotId, a.id);
  assert.equal((await client.active()).id, a.id);
  const damaged = await client.index([second.id], "build-damaged");
  // Inject a missing index entry freshly created by this test. Production roles cannot do this.
  await sql`delete from readily_v1.index_entries where snapshot_id = ${damaged.id} and child_id = 'p1-c1'`;
  await assert.rejects(client.activate(damaged.id, a.id, "damaged"), expectedError(409, "index_validation_failed"));
  assert.equal((await client.active()).id, a.id);
  await client.activate(b.id, a.id, "activate-b");
  await assert.rejects(client.activate(a.id, a.id, "bad-cas"), expectedError(409, "active_snapshot_changed"));
  const newer = await client.evaluate(question, "new-eval", "2024-01-01");
  assert.equal(newer.snapshotId, b.id);
  assert.ok(newer.result.excerpts.some(item => item.documentVersionId === second.id && item.quote.includes("amber")));
  const beforeEffective = await client.evaluate(question, "before-effective", "2020-06-01");
  assert.equal(beforeEffective.result.status, "insufficient");
  assert.deepEqual(await client.json(evidencePath), complete);
  assert.equal(sha(Buffer.from(await (await client.request(`/documents/${first.id}/source`)).arrayBuffer())), sha(original));

  await client.activate(a.id, b.id, "rollback");
  const recovered = await client.evaluate(question, "rollback-eval", "2024-01-01");
  assert.equal(recovered.snapshotId, a.id);
  assert.equal((await client.report(newer.id)).snapshotId, b.id);
  assert.equal((await client.report(old.id)).snapshotId, a.id);
  console.log("HTTP parent deduplication, tenant isolation, idempotency, historical PDF and snapshot recovery passed");

  const crossPolicy = (await newTenant()).client;
  const dispatch = await crossPolicy.upload(synthPdf([pdfLines([
    "Section 4.1 Dispatch", "The lead records manifest reviews. See section 7.1 for exceptions.",
  ])]), { ...metadata, documentKey: "dispatch" }, "dispatch");
  const inventory = await crossPolicy.upload(synthPdf([
    pdfLines(["Section 7.1 Inventory", "Except leased units, which require a separate count."])
      + "\n" + pdfGrid([["Item", "Quantity"], ["Seal", "Twelve"]], 655),
  ]), { ...metadata, documentKey: "inventory" }, "inventory");
  const combined = await crossPolicy.index([dispatch.id, inventory.id], "cross-index");
  await crossPolicy.activate(combined.id, null, "cross-activate");
  const questions = ["Which policy records manifest reviews?", "Which rule covers counting leased units?"];
  const combinedReport = await crossPolicy.evaluate(questions.join(" "), "combined", "2024-01-01");
  const splitReports: Report[] = [];
  for (const [index, question] of questions.entries()) {
    splitReports.push(await crossPolicy.evaluate(question, `split-${index}`, "2024-01-01"));
  }
  const rankedVersions = (reports: Report[]) => new Set(reports
    .flatMap(report => report.result.parents.filter(parent => parent.hits.length).map(parent => parent.documentVersionId)));
  const referenced = await crossPolicy.evaluate("What does section 4.1 state?", "follow-ref", "2024-01-01");
  assert.equal(referenced.result.parents.filter(parent => parent.documentVersionId === inventory.id).length, 1);
  assert.ok(referenced.result.exceptions.some(item => item.documentVersionId === inventory.id));
  assert.equal(referenced.result.status, "needs_review");
  const inventoryPath = `/reports/${referenced.id}/evidence/${inventory.id}/p1`;
  const inventoryParent = await crossPolicy.json<{ block: ParentBlock }>(inventoryPath);
  const quantity = inventoryParent.block.units.find(unit => unit.table?.row === 2);
  assert.ok(quantity);
  const cell = await crossPolicy.locate(referenced.id, {
    documentVersionId: inventory.id, parentId: "p1", unitId: quantity.id, column: 2, quote: "Twelve",
  });
  assert.equal(cell.cell?.text, "Twelve");
  assert.equal(cell.cell?.box.page, 1);
  console.log(JSON.stringify({
    crossPolicySourceCoverage: { combined: rankedVersions([combinedReport]).size, split: rankedVersions(splitReports).size, total: 2 },
  }));

  const standalone = await newTenant();
  const run = await runFile(process.execPath, ["examples/readily-v1/run.ts"], {
    env: { ...process.env, READILY_API_ORIGIN: origin, READILY_API_KEY: standalone.token }, timeout: 60000, windowsHide: true,
  });
  const result = JSON.parse(run.stdout);
  assert.equal(result.page, 1);
  assert.equal(result.status, "supported");
  assert.equal(result.reviewState, "needs_review");
  console.log("Standalone Node TypeScript example passed");
  await benchmark((await newTenant()).client);
} finally {
  try {
    if (tenantIds.length) {
      const ids = sql.array(tenantIds);
      const deleted = await sql`delete from readily_v1.tenants where id = any(${ids}::uuid[]) returning id`;
      assert.equal(deleted.length, tenantIds.length);
      const [remaining] = await sql`
        select exists (select 1 from readily_v1.document_versions where tenant_id = any(${ids}::uuid[])
          union all select 1 from readily_v1.reports where tenant_id = any(${ids}::uuid[])
          union all select 1 from readily_v1.snapshot_documents where tenant_id = any(${ids}::uuid[])
          union all select 1 from readily_v1.requests where tenant_id = any(${ids}::uuid[])
          union all select 1 from readily_v1.api_keys where tenant_id = any(${ids}::uuid[])) as data
      `;
      assert.equal(remaining.data, false);
      console.log("Synthetic tenant data retention cleanup passed");
    }
  } finally {
    await sql.end({ timeout: 5 });
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") {
        await runFile("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true }).catch(() => {});
        if (child.exitCode === null) await runFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  }
}
