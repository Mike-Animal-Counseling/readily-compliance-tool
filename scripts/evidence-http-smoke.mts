import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { createClient } from "../examples/readily-v1/client";
import type { Report } from "../examples/readily-v1/client";
import type { ParentBlock } from "../lib/evidence/model";
import { benchmark } from "../tests/evidence-benchmark";
import { pdfGrid, pdfLines, synthPdf } from "../tests/fixtures/policy-pdf";
import { expectedError, policyFixtureMetadata, verifyEvidenceCanary, versionPdf } from "./verify-evidence-canary";

const database = process.env.READILY_V1_TEST_DATABASE_URL;
if (!database) throw new Error("Set READILY_V1_TEST_DATABASE_URL to a disposable local PostgreSQL database");
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const url = new URL(database);
assert.ok(loopback.has(url.hostname) && url.pathname === "/readily_v1_test");
const redis = process.env.READILY_V1_TEST_REDIS_URL;
if (redis) {
  const cache = new URL(redis);
  assert.ok(loopback.has(cache.hostname) && cache.protocol === "rediss:" && cache.password,
    "Production smoke requires a disposable authenticated TLS Redis on loopback");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
}
const sql = postgres(database, { max: 1, connect_timeout: 5, onnotice: () => {} });
const origin = "http://127.0.0.1:3011";
const appOrigin = redis ? origin.replace(/^http:/, "https:") : origin;
const accessCode = randomBytes(32).toString("hex");
const rerankToken = randomBytes(32).toString("hex");
const crowdedQuestion = "Where is synthetic manifest verification required?";
let rerankCalls = 0;
let rerankAvailable = true;
const reranker = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (request.url !== "/rerank" || request.headers.authorization !== `Bearer ${rerankToken}` ||
      body.query !== crowdedQuestion || !rerankAvailable) {
    response.writeHead(503).end();
    return;
  }
  rerankCalls++;
  assert.equal(body.top_n, 7);
  assert.equal(body.documents.length, 7);
  assert.ok(body.documents.every((text: string) => text.includes("Synthetic manifest verification")));
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    results: body.documents.map((text: string, index: number) => ({
      index, relevance_score: text.includes("Section 7.") ? 0.99 : 0.25,
    })),
  }));
});
await new Promise<void>((resolve, reject) => reranker.once("error", reject).listen(0, "127.0.0.1", resolve));
const rerankAddress = reranker.address();
assert.ok(rerankAddress && typeof rerankAddress === "object");
const tenantIds: string[] = [];
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
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

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", redis ? "start" : "dev", "-p", "3011", "-H", "127.0.0.1"], {
  env: { ...process.env, NODE_ENV: redis ? "production" : "development", APP_ORIGIN: appOrigin, REDIS_URL: redis ?? "",
    DEMO_ACCESS_CODE: accessCode, SESSION_SECRET: randomBytes(32).toString("hex"),
    OPENROUTER_API_KEY: "", READILY_V1_ENABLED: "true", READILY_V1_DATABASE_URL: database,
    READILY_V1_RERANK_PORT: String(rerankAddress.port), READILY_V1_RERANK_TOKEN: rerankToken,
    READILY_V1_RERANK_MODEL: "synthetic-reranker@1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream?.on("data", progress => { logs = (logs + String(progress)).slice(-6000); });

async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + "/api/v1/snapshots/active", { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (response.status === 401) return;
    } catch {}
    await delay(500);
  }
  throw new Error("Local Next.js API did not start\n" + logs);
}

async function checkProductionWorkspace() {
  // The local HTTP hop simulates requests forwarded by an HTTPS terminator.
  const page = await fetch(origin + "/demo-access", { signal: AbortSignal.timeout(10000) });
  assert.equal(page.status, 200, "Production login page failed");
  assert.match(page.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  assert.match(page.headers.get("content-security-policy") ?? "", /'nonce-[^']+'/);
  await page.body?.cancel();
  const login = await fetch(origin + "/api/demo-access", {
    method: "POST",
    headers: { origin: appOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: accessCode }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(login.status, 200, "Production login failed");
  const cookie = login.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^__Host-readily_session=/);
  assert.match(cookie, /;\s*Secure(?:;|$)/i);
  assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
  await login.body?.cancel();
  const body = new FormData();
  body.append("policies", new Blob([new Uint8Array(versionPdf("indigo"))], { type: "application/pdf" }), "synthetic.pdf");
  const parsed = await fetch(origin + "/api/parse-policies", {
    method: "POST",
    headers: { origin: appOrigin, cookie: cookie.split(";")[0] },
    body,
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(parsed.status, 200, "Production workspace PDF upload failed");
  assert.equal((await parsed.json()).documents[0].pageCount, 4);
  const [connection] = await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
  assert.equal(connection.ssl, true);
  console.log("Built Next.js workspace login, Secure session, isolated PDF upload and TLS services passed");
}

try {
  const [schema] = await sql`select to_regclass('readily_v1.reviews') is not null as migrated`;
  if (!schema.migrated) {
    await sql.unsafe(await readFile(join("db", "migrations", "001_versioned_evidence.sql"), "utf8"));
  }
  const [reviews] = await sql`select exists (select 1 from information_schema.columns
    where table_schema = 'readily_v1' and table_name = 'reviews' and column_name = 'answer_override') as migrated`;
  if (!reviews.migrated) {
    await sql.unsafe(await readFile(join("db", "migrations", "002_review_answers.sql"), "utf8"));
  }
  await sql.unsafe(await readFile(join("db", "migrations", "003_rerank_passages.sql"), "utf8"));
  await ready();
  if (redis) await checkProductionWorkspace();
  const { client } = await newTenant();
  const other = (await newTenant()).client;
  const readOnly = (await newTenant(["read"])).client;
  await assert.rejects(readOnly.evaluate("Check scope", "scope"), expectedError(403, "scope_required"));
  await verifyEvidenceCanary(client, other, async (pendingVersionId, activeSnapshotId) => {
    const damaged = await client.index([pendingVersionId], "build-damaged");
    // Inject a missing entry into the disposable index. The runtime role cannot delete entries.
    await sql`delete from readily_v1.index_entries where snapshot_id = ${damaged.id} and child_id = 'p1-c1'`;
    await assert.rejects(client.activate(damaged.id, activeSnapshotId, "damaged"), expectedError(409, "index_validation_failed"));
    assert.equal((await client.active()).id, activeSnapshotId);
  });
  const crowded = await newTenant();
  const crowdedClauses = synthPdf([pdfLines(Array.from({ length: 7 }, (_, i) =>
    `Section ${i + 1}. Synthetic manifest verification.`))]);
  const crowdedDocument = await crowded.client.upload(crowdedClauses, policyFixtureMetadata, "crowded-document");
  const crowdedSnapshot = await crowded.client.index([crowdedDocument.id], "crowded-index");
  // Give every child an identical search score, with one parent filling the old child limit.
  await sql`
    update readily_v1.index_entries child set search = template.search, embedding = template.embedding
    from readily_v1.index_entries template
    where child.tenant_id = ${crowded.id} and child.snapshot_id = ${crowdedSnapshot.id}
      and template.tenant_id = child.tenant_id and template.snapshot_id = child.snapshot_id and template.child_id = 'p1-c1'
  `;
  await sql`
    insert into readily_v1.index_entries
      (tenant_id, snapshot_id, document_version_id, parent_id, child_id, unit_ids, clauses, search, embedding)
    select e.tenant_id, e.snapshot_id, e.document_version_id, e.parent_id,
      'p1-extra-' || lpad(n::text, 3, '0'), e.unit_ids, e.clauses, e.search, e.embedding
    from readily_v1.index_entries e cross join generate_series(1, 140) as fixture(n)
    where e.tenant_id = ${crowded.id} and e.snapshot_id = ${crowdedSnapshot.id} and e.child_id = 'p1-c1'
  `;
  await sql`update readily_v1.snapshots set entry_count = entry_count + 140
    where tenant_id = ${crowded.id} and id = ${crowdedSnapshot.id}`;
  await crowded.client.activate(crowdedSnapshot.id, null, "crowded-activate");
  const resultWithCrowdedHits = await crowded.client.evaluate(crowdedQuestion, "crowded-evaluate");
  assert.deepEqual(resultWithCrowdedHits.result.retrieval, { method: "cross_encoder", model: "synthetic-reranker@1" });
  assert.deepEqual(resultWithCrowdedHits.result.parents.map(parent => parent.parentId), ["p7", "p1", "p2", "p3", "p4"]);
  const completeParent = await crowded.client.json<{ block: ParentBlock; hits: { childId: string }[] }>(
    `/reports/${resultWithCrowdedHits.id}/evidence/${crowdedDocument.id}/p1`,
  );
  assert.equal(completeParent.block.id, "p1");
  assert.equal(new Set(completeParent.hits.map(hit => hit.childId)).size, 141);
  await assert.rejects(other.evaluateBatch([crowdedQuestion], "foreign-batch", { snapshotId: crowdedSnapshot.id }),
    expectedError(404, "usable_snapshot_not_found"));
  await assert.rejects(crowded.client.evaluateBatch([], "invalid-batch"), expectedError(400, "invalid_input"));
  const atomicBatch = await crowded.client.evaluateBatch([crowdedQuestion, "Quote section 2"], "atomic-batch");
  await assert.rejects(crowded.client.evaluateBatch([crowdedQuestion], "atomic-batch"), expectedError(409, "idempotency_conflict"));
  assert.equal(atomicBatch.reports.length, 2);
  assert.equal(atomicBatch.reports[1].result.retrieval?.method, "rrf");
  assert.equal(atomicBatch.reports[1].result.parents[0].parentId, "p2");
  assert.equal(rerankCalls, 2);
  rerankAvailable = false;
  const offline = await crowded.client.evaluate(crowdedQuestion, "crowded-offline");
  assert.deepEqual(offline.result.retrieval, { method: "rrf", fallback: "model_unavailable" });
  assert.deepEqual(offline.result.parents.map(parent => parent.parentId), ["p1", "p2", "p3", "p4", "p5"]);
  rerankAvailable = true;
  await sql`update readily_v1.index_entries set rerank_text = null
    where tenant_id = ${crowded.id} and snapshot_id = ${crowdedSnapshot.id}`;
  const oldSnapshot = await crowded.client.evaluate(crowdedQuestion, "crowded-old-snapshot");
  assert.deepEqual(oldSnapshot.result.retrieval, { method: "rrf", fallback: "missing_passages" });
  assert.deepEqual(oldSnapshot.result.parents, offline.result.parents);
  assert.deepEqual(await crowded.client.evaluate(crowdedQuestion, "crowded-evaluate"), resultWithCrowdedHits);
  assert.equal(rerankCalls, 2);
  console.log("Reranking, five distinct parents, 141 child positions, exact clauses, replay and both fallbacks passed");

  const crossPolicy = (await newTenant()).client;
  const metadata = policyFixtureMetadata;
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
  if (redis) {
    const primary = await newTenant();
    const isolation = await newTenant(["read", "index", "review"]);
    const canary = await runFile(process.execPath, ["--import", "tsx", "scripts/evidence-live-smoke.mts"], {
      env: { ...process.env, READILY_API_ORIGIN: origin, READILY_V1_CANARY_PRIMARY_KEY: primary.token,
        READILY_V1_CANARY_ISOLATION_KEY: isolation.token }, timeout: 60000, windowsHide: true,
    });
    assert.match(canary.stdout, /snapshot recovery passed/);
    console.log("Standalone canary command passed");
  }
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
    reranker.close();
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
