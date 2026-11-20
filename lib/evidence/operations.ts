import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assess } from "./assessment";
import type { Assessment } from "./assessment";
import { evidenceDb } from "./connection";
import { bodyBytes, idempotent, readJson, sha256 } from "./http";
import type { Principal } from "./http";
import type { ParentBlock } from "./model";
import { embeddingVersion, indexVersion } from "./model";
import { activateSnapshot, buildSnapshot, createDocument, EvidenceError } from "./repository";
import type { Transaction } from "./repository";

const uuid = z.uuid().transform(value => value.toLowerCase());
const questionText = z.string().trim().min(1).max(1000).refine(value => !value.includes("\0"));
const assessmentDate = z.iso.date().refine(value => !value.startsWith("0000-")).optional();
const metadata = z.object({
  documentKey: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  fileName: z.string().trim().min(5).max(180).regex(/^[^/\\\p{C}]+\.pdf$/iu),
  effectiveFrom: z.iso.date(),
  effectiveUntil: z.iso.date().optional(),
}).strict().refine(value => !value.effectiveUntil || value.effectiveUntil > value.effectiveFrom);

function validate<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) throw new EvidenceError(400, "invalid_input");
  return result.data;
}

export async function upload(request: Request, { tenant }: Principal) {
  const input = validate(metadata, Object.fromEntries(new URL(request.url).searchParams));
  const bytes = await bodyBytes(request, "application/pdf");
  return idempotent(request, tenant, "upload", "ingest", { input, digest: sha256(bytes) },
    sql => createDocument(sql, tenant, { ...input, bytes }));
}

export async function documentVersion(tenant: string, version: string, source: boolean) {
  const id = validate(uuid, version);
  const sql = evidenceDb();
  if (source) {
    const [row] = await sql<{ pdf: Buffer }[]>`select pdf from readily_v1.document_versions where tenant_id = ${tenant} and id = ${id}`;
    if (!row) throw new EvidenceError(404, "document_version_not_found");
    return new Response(new Uint8Array(row.pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="policy-${id}.pdf"` },
    });
  }
  const [row] = await sql`
    select id, document_key as "documentKey", file_name as "fileName", sha256, parser_version as "parserVersion",
      page_count as "pageCount", warnings, effective_from::text as "effectiveFrom", effective_until::text as "effectiveUntil",
      case when warnings = '[]'::jsonb then 'ready' else 'needs_review' end as status
    from readily_v1.document_versions where tenant_id = ${tenant} and id = ${id}
  `;
  if (!row) throw new EvidenceError(404, "document_version_not_found");
  return Response.json(row);
}

export async function indexSnapshot(request: Request, { tenant }: Principal) {
  const { documentVersionIds } = validate(z.object({ documentVersionIds: z.array(uuid).min(1).max(20) }).strict(), await readJson(request));
  const ids = [...new Set(documentVersionIds)].sort();
  if (ids.length !== documentVersionIds.length) throw new EvidenceError(400, "duplicate_document_version");
  return idempotent(request, tenant, "build_snapshot", "index", ids, sql => buildSnapshot(sql, tenant, ids));
}

export async function activate(request: Request, { tenant }: Principal, id: string) {
  const snapshot = validate(uuid, id);
  const { expectedActiveSnapshotId } = validate(z.object({ expectedActiveSnapshotId: uuid.nullable() }).strict(), await readJson(request));
  return idempotent(request, tenant, "activate_snapshot", "index", { snapshot, expectedActiveSnapshotId },
    sql => activateSnapshot(sql, tenant, snapshot, expectedActiveSnapshotId), 200);
}

export async function snapshotStatus(tenant: string, snapshot: string) {
  const sql = evidenceDb();
  if (snapshot === "active") {
    const [row] = await sql`select active_snapshot_id as id from readily_v1.tenants where id = ${tenant}`;
    return Response.json({ id: row?.id ?? null });
  }
  const id = validate(uuid, snapshot);
  const [row] = await sql`
    select s.id, s.embedding_version as "embeddingVersion", s.index_version as "indexVersion", s.entry_count as "entryCount",
      case when t.active_snapshot_id = s.id then 'active' else 'ready' end as status
    from readily_v1.snapshots s join readily_v1.tenants t on t.id = s.tenant_id
    where s.tenant_id = ${tenant} and s.id = ${id}
  `;
  if (!row) throw new EvidenceError(404, "snapshot_not_found");
  return Response.json(row);
}

async function assessmentContext(sql: Transaction, tenant: string, asOf?: string, snapshotId?: string) {
  const [row] = await sql<{ snapshot: string; day: string }[]>`
    select s.id as snapshot, (now() at time zone 'UTC')::date::text as day
    from readily_v1.tenants t join readily_v1.snapshots s
      on s.tenant_id = t.id and s.id = coalesce(${snapshotId ?? null}::uuid, t.active_snapshot_id)
      and s.embedding_version = ${embeddingVersion} and s.index_version = ${indexVersion}
    where t.id = ${tenant} and (
      s.id = t.active_snapshot_id or exists (
        select 1 from readily_v1.activations a where a.tenant_id = t.id and a.new_snapshot_id = s.id
      )
    )
  `;
  if (!row) {
    if (snapshotId) throw new EvidenceError(404, "usable_snapshot_not_found");
    throw new EvidenceError(409, "active_snapshot_required");
  }
  return { snapshotId: row.snapshot, asOf: asOf ?? row.day };
}

async function createReport(sql: Transaction, tenant: string, context: { snapshotId: string; asOf: string }, question: string) {
  const id = randomUUID();
  const { snapshotId, asOf } = context;
  const result = await assess(sql, tenant, snapshotId, asOf, question);
  await sql`insert into readily_v1.reports (tenant_id, id, snapshot_id, as_of, result)
    values (${tenant}, ${id}, ${snapshotId}, ${asOf}, ${sql.json(result)})`;
  return { id, snapshotId, asOf, status: "completed" as const, result };
}

export async function evaluate(request: Request, { tenant }: Principal) {
  const input = validate(z.object({ question: questionText, asOf: assessmentDate }).strict(), await readJson(request));
  return idempotent(request, tenant, "evaluate", "evaluate", input, async sql => {
    return createReport(sql, tenant, await assessmentContext(sql, tenant, input.asOf), input.question);
  });
}

export async function evaluateBatch(request: Request, { tenant }: Principal) {
  const input = validate(z.object({
    questions: z.array(questionText).min(1).max(5), asOf: assessmentDate, snapshotId: uuid.optional(),
  }).strict(), await readJson(request));
  return idempotent(request, tenant, "evaluate_batch", "evaluate", input, async sql => {
    const context = await assessmentContext(sql, tenant, input.asOf, input.snapshotId);
    const reports: Awaited<ReturnType<typeof createReport>>[] = [];
    for (const question of input.questions) {
      reports.push(await createReport(sql, tenant, context, question));
    }
    return { ...context, status: "completed", reports };
  });
}

export async function reportStatus(tenant: string, report: string) {
  const id = validate(uuid, report);
  const sql = evidenceDb();
  const [row] = await sql`
    select r.id, r.snapshot_id as "snapshotId", r.as_of::text as "asOf", r.result,
      v.revision::text as "reviewRevision", coalesce(v.state, 'pending') as "reviewState"
    from readily_v1.reports r
    left join lateral (select revision, state from readily_v1.reviews
      where tenant_id = r.tenant_id and report_id = r.id order by revision desc limit 1) v on true
    where r.tenant_id = ${tenant} and r.id = ${id}
  `;
  if (!row) throw new EvidenceError(404, "report_not_found");
  return Response.json({ ...row, status: "completed" });
}

export async function locateEvidence(tenant: string, report: string, version: string, parent: string, unit?: string, column?: string) {
  const id = validate(uuid, report);
  const documentVersionId = validate(uuid, version);
  const sql = evidenceDb();
  const [row] = await sql<{ block: ParentBlock; result: Assessment }[]>`
    select p.block, r.result
    from readily_v1.reports r join readily_v1.snapshot_documents sd on sd.tenant_id = r.tenant_id and sd.snapshot_id = r.snapshot_id
    join readily_v1.parents p on p.tenant_id = sd.tenant_id and p.document_version_id = sd.document_version_id
    where r.tenant_id = ${tenant} and r.id = ${id} and p.document_version_id = ${documentVersionId} and p.id = ${parent}
      and r.result->'parents' @> ${sql.json([{ documentVersionId, parentId: parent }])}
  `;
  const matches = row?.result.parents.find(match => match.documentVersionId === documentVersionId && match.parentId === parent);
  if (!row || !matches) throw new EvidenceError(404, "evidence_not_found");
  const source = `/api/v1/documents/${documentVersionId}/source`;
  if (!unit) return Response.json({ documentVersionId, source, block: row.block, hits: matches.hits });
  const evidence = row.block.units.find(item => item.id === unit);
  if (!evidence) throw new EvidenceError(404, "evidence_not_found");
  const cell = column !== undefined ? evidence.table?.cells.find(item => String(item.column) === column) : undefined;
  if (column !== undefined && !cell) throw new EvidenceError(404, "evidence_not_found");
  return Response.json({ documentVersionId, parentId: parent, source, unit: evidence, ...(cell ? { cell } : {}) });
}

export async function review(request: Request, { tenant, label }: Principal, report: string) {
  const id = validate(uuid, report);
  const input = validate(z.object({
    state: z.enum(["approved", "needs_review"]),
    notes: z.string().trim().min(1).max(4000).refine(value => !value.includes("\0")),
    answerOverride: z.string().trim().min(1).max(4000).refine(value => !value.includes("\0")).optional(),
    expectedRevision: z.string().regex(/^\d{1,19}$/).nullable(),
  }).strict(), await readJson(request));
  return idempotent(request, tenant, "review", "review", { id, label, ...input }, async sql => {
    const [exists] = await sql`select 1 from readily_v1.reports where tenant_id = ${tenant} and id = ${id}`;
    if (!exists) throw new EvidenceError(404, "report_not_found");
    const [previous] = await sql<{ revision: string }[]>`select revision::text from readily_v1.reviews
      where tenant_id = ${tenant} and report_id = ${id} order by revision desc limit 1`;
    if ((previous?.revision ?? null) !== input.expectedRevision) throw new EvidenceError(409, "review_revision_changed");
    const [entry] = await sql<{ revision: string; createdAt: Date }[]>`
      insert into readily_v1.reviews (tenant_id, report_id, reviewer, state, notes, answer_override)
      values (${tenant}, ${id}, ${label}, ${input.state}, ${input.notes}, ${input.answerOverride ?? null})
      returning revision::text, created_at as "createdAt"
    `;
    return { reportId: id, revision: entry.revision, createdAt: entry.createdAt.toISOString(),
      reviewer: label, state: input.state, notes: input.notes, answerOverride: input.answerOverride ?? null };
  });
}

export async function reviews(tenant: string, report: string, before?: string) {
  const id = validate(uuid, report);
  const cursor = before === undefined ? null : validate(z.string().regex(/^\d{1,19}$/)
    .refine(value => BigInt(value) <= BigInt("9223372036854775807")), before);
  const sql = evidenceDb();
  const [exists] = await sql`select 1 from readily_v1.reports where tenant_id = ${tenant} and id = ${id}`;
  if (!exists) throw new EvidenceError(404, "report_not_found");
  const rows = await sql`
    select report_id as "reportId", revision::text, reviewer, state, notes,
      answer_override as "answerOverride", created_at as "createdAt"
    from readily_v1.reviews where tenant_id = ${tenant} and report_id = ${id}
      and (${cursor}::bigint is null or revision < ${cursor}::bigint)
    order by revision desc limit 51
  `;
  return Response.json({ items: rows.slice(0, 50), nextBefore: rows.length > 50 ? rows[49].revision : null });
}
