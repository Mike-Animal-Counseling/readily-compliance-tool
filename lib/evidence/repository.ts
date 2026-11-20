import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createTextEmbedding } from "../rag/embeddings";
import { parsePolicy } from "./layout";
import { embeddingVersion, indexVersion, makeChildren, parserVersion } from "./model";
import type { ParentBlock, ParsedPolicy } from "./model";
import { parentKey, rankParents } from "./parents";
import type { ChildHit, ParentMatch } from "./parents";

export type Transaction = postgres.TransactionSql;

export class EvidenceError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

type Upload = {
  bytes: Buffer;
  documentKey: string;
  fileName: string;
  effectiveFrom: string;
  effectiveUntil?: string;
};

export async function createDocument(sql: Transaction, tenant: string, upload: Upload) {
  const [{ count }] = await sql`select count(*)::int as count from readily_v1.document_versions where tenant_id = ${tenant}`;
  if (count >= 100) throw new EvidenceError(409, "document_quota");
  let parsed: ParsedPolicy;
  try {
    parsed = await parsePolicy(upload.bytes);
  } catch (error) {
    if (error instanceof Error && error.message === "PDF processor busy") throw new EvidenceError(429, "parser_busy");
    throw new EvidenceError(422, "invalid_pdf");
  }
  const id = randomUUID();
  const sha256 = createHash("sha256").update(upload.bytes).digest("hex");
  const status = parsed.warnings.length ? "needs_review" : "ready";
  const size = parsed.parents.reduce((total, block) => total + Buffer.byteLength(JSON.stringify(block)), 0);
  if (size > 2 * 1024 * 1024 || parsed.parents.some(block => Buffer.byteLength(JSON.stringify(block)) > 512 * 1024)) {
    throw new EvidenceError(422, "document_layout_too_large");
  }
  await sql`
    insert into readily_v1.document_versions
      (tenant_id, id, document_key, file_name, sha256, pdf, parser_version, warnings, page_count, effective_from, effective_until)
    values (${tenant}, ${id}, ${upload.documentKey}, ${upload.fileName}, ${sha256}, ${upload.bytes},
      ${parserVersion}, ${sql.json(parsed.warnings)}, ${parsed.pageCount}, ${upload.effectiveFrom}, ${upload.effectiveUntil ?? null})
  `;
  if (parsed.parents.length) {
    await sql`insert into readily_v1.parents ${sql(parsed.parents.map(block => ({
      tenant_id: tenant, document_version_id: id, id: block.id, block: sql.json(block),
    })), "tenant_id", "document_version_id", "id", "block")}`;
  }
  const locations = parsed.parents.flatMap(block => [...new Set(block.units.flatMap(unit => unit.clause ? [unit.clause] : []))]
    .map(clause => ({ tenant_id: tenant, document_version_id: id, parent_id: block.id, clause })));
  for (let offset = 0; offset < locations.length; offset += 1000) {
    await sql`insert into readily_v1.clause_locations ${sql(locations.slice(offset, offset + 1000),
      "tenant_id", "document_version_id", "parent_id", "clause")}`;
  }
  return { id, status, sha256, parserVersion, pageCount: parsed.pageCount, warnings: parsed.warnings };
}

export async function buildSnapshot(sql: Transaction, tenant: string, documentVersionIds: string[]) {
  const [{ count }] = await sql`select count(*)::int as count from readily_v1.snapshots where tenant_id = ${tenant}`;
  if (count >= 40) throw new EvidenceError(409, "snapshot_quota");
  const docs = await sql<{id: string; document_key: string}[]>`
    select id, document_key from readily_v1.document_versions
    where tenant_id = ${tenant} and id = any(${sql.array(documentVersionIds)}::uuid[])
  `;
  if (docs.length !== documentVersionIds.length) throw new EvidenceError(404, "document_version_not_found");
  const [overlap] = await sql`
    select 1 from readily_v1.document_versions a join readily_v1.document_versions b
      on a.tenant_id = b.tenant_id and a.document_key = b.document_key and a.id < b.id
    where a.tenant_id = ${tenant} and a.id = any(${sql.array(documentVersionIds)}::uuid[])
      and b.id = any(${sql.array(documentVersionIds)}::uuid[])
      and daterange(a.effective_from, a.effective_until) && daterange(b.effective_from, b.effective_until)
    limit 1
  `;
  if (overlap) throw new EvidenceError(409, "overlapping_policy_versions");
  const parents = await sql<{ document_version_id: string; block: ParentBlock }[]>`
    select document_version_id, block from readily_v1.parents
    where tenant_id = ${tenant} and document_version_id = any(${sql.array(documentVersionIds)}::uuid[])
  `;
  if (new Set(parents.map(row => row.document_version_id)).size !== docs.length) {
    throw new EvidenceError(422, "unreadable_document_version");
  }
  const entries = parents.flatMap(({ document_version_id, block }) => makeChildren(block)
    .map(child => ({ document_version_id, ...child })));
  if (!entries.length || entries.length > 10000) throw new EvidenceError(422, "index_size_limit");
  const id = randomUUID();
  await sql`insert into readily_v1.snapshots
    (tenant_id, id, embedding_version, index_version, entry_count)
    values (${tenant}, ${id}, ${embeddingVersion}, ${indexVersion}, ${entries.length})`;
  await sql`insert into readily_v1.snapshot_documents ${sql(documentVersionIds.map(documentVersionId => ({
    tenant_id: tenant, snapshot_id: id, document_version_id: documentVersionId,
  })), "tenant_id", "snapshot_id", "document_version_id")}`;
  for (let offset = 0; offset < entries.length; offset += 100) {
    const rows = entries.slice(offset, offset + 100).map(entry => ({
      version: entry.document_version_id,
      parent: entry.parentId,
      child: entry.id,
      units: entry.unitIds,
      clauses: entry.clauses,
      body: entry.text,
      embedding: JSON.stringify(createTextEmbedding(entry.text)),
    }));
    await sql`
      insert into readily_v1.index_entries
        (tenant_id, snapshot_id, document_version_id, parent_id, child_id, unit_ids, clauses, search, embedding)
      select ${tenant}::uuid, ${id}::uuid, version::uuid, parent, child, units, clauses, to_tsvector('simple', body), embedding::vector
      from jsonb_to_recordset(${sql.json(rows)})
        as item(version text, parent text, child text, units text[], clauses text[], body text, embedding text)
    `;
  }
  return { id, embeddingVersion, indexVersion, entryCount: entries.length, status: "ready" };
}

export async function activateSnapshot(sql: Transaction, tenant: string, id: string, expected: string | null) {
  const [snapshot] = await sql<{ entry_count: number }[]>`
    select entry_count from readily_v1.snapshots
    where tenant_id = ${tenant} and id = ${id} and embedding_version = ${embeddingVersion} and index_version = ${indexVersion}
  `;
  if (!snapshot) throw new EvidenceError(404, "compatible_snapshot_not_found");
  const [{ count }] = await sql`select count(*)::int as count from readily_v1.index_entries
    where tenant_id = ${tenant} and snapshot_id = ${id}`;
  if (count !== snapshot.entry_count) throw new EvidenceError(409, "index_validation_failed");
  const [updated] = await sql`
    update readily_v1.tenants set active_snapshot_id = ${id}
    where id = ${tenant} and active_snapshot_id is not distinct from ${expected}::uuid returning id
  `;
  if (!updated) throw new EvidenceError(409, "active_snapshot_changed");
  await sql`insert into readily_v1.activations (tenant_id, new_snapshot_id, previous_snapshot_id) values (${tenant}, ${id}, ${expected})`;
  return { id, previousSnapshotId: expected, status: "active" };
}

export async function findParents(sql: Transaction, tenant: string, snapshot: string, asOf: string, question: string, clauses: string[]) {
  const topK = 5;
  const vector = createTextEmbedding(question);
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(term => term.length > 2 && !["the", "and", "what", "are", "does", "how", "that", "for", "with", "can"].includes(term))
    .slice(0, 40);
  const rows = await sql<ChildHit[]>`
    with eligible as materialized (
      select i.* from readily_v1.index_entries i
      join readily_v1.document_versions d on d.tenant_id = i.tenant_id and d.id = i.document_version_id
      where i.tenant_id = ${tenant} and i.snapshot_id = ${snapshot}
        and daterange(d.effective_from, d.effective_until) @> ${asOf}::date
    ), query as (
      select websearch_to_tsquery('simple', ${terms.join(" OR ")}) as terms,
        ${JSON.stringify(vector)}::vector as embedding, ${sql.array(clauses)}::text[] as clauses
    ), signals as (
      select e.document_version_id, e.child_id, 3.0 / (60 + row_number() over (order by e.document_version_id, e.child_id)) as weight
      from eligible e, query q where e.clauses && q.clauses
      union all
      select e.document_version_id, e.child_id, 1.0 / (60 + row_number() over
        (order by ts_rank_cd(e.search, q.terms) desc, e.document_version_id, e.child_id))
      from eligible e, query q where e.search @@ q.terms
      union all
      select e.document_version_id, e.child_id, 1.0 / (60 + row_number() over
        (order by e.embedding <=> q.embedding, e.document_version_id, e.child_id))
      from eligible e, query q where (e.embedding <=> q.embedding) < 0.8
    ), scored as materialized (
      select document_version_id, child_id, sum(weight)::float8 as score
      from signals group by document_version_id, child_id
    ), selected_parents as (
      select e.document_version_id, e.parent_id, max(s.score) as parent_score
      from scored s join eligible e using (document_version_id, child_id)
      group by e.document_version_id, e.parent_id
      order by parent_score desc, e.document_version_id, e.parent_id
      limit ${topK}
    )
    select s.document_version_id as "documentVersionId", e.parent_id as "parentId", s.child_id as "childId",
      e.unit_ids as "unitIds", s.score
    from scored s join eligible e using (document_version_id, child_id)
    join selected_parents p on p.document_version_id = e.document_version_id and p.parent_id = e.parent_id
  `;
  return rankParents(rows, topK);
}

export async function findReferencedParents(sql: Transaction, tenant: string, snapshot: string, asOf: string, clauses: string[]) {
  return await sql<{ documentVersionId: string; parentId: string; clause: string }[]>`
    select l.document_version_id as "documentVersionId", l.parent_id as "parentId", l.clause
    from readily_v1.clause_locations l
    join readily_v1.snapshot_documents s using (tenant_id, document_version_id)
    join readily_v1.document_versions d on d.tenant_id = l.tenant_id and d.id = l.document_version_id
    where l.tenant_id = ${tenant} and s.snapshot_id = ${snapshot}
      and l.clause = any(${sql.array(clauses)}::text[])
      and daterange(d.effective_from, d.effective_until) @> ${asOf}::date
  `;
}

export async function readParents(sql: Transaction, tenant: string, matches: ParentMatch[]) {
  if (!matches.length) return [];
  const rows = await sql<{ documentVersionId: string; parentId: string; block: ParentBlock }[]>`
    select p.document_version_id as "documentVersionId", p.id as "parentId", p.block
    from readily_v1.parents p join jsonb_to_recordset(${sql.json(matches.map(match => ({
      version: match.documentVersionId, parent: match.parentId,
    })))}) as requested(version uuid, parent text)
    on p.document_version_id = requested.version and p.id = requested.parent
    where p.tenant_id = ${tenant}
  `;
  const blocks = new Map(rows.map(row => [parentKey(row), row.block]));
  return matches.flatMap(match => {
    const block = blocks.get(parentKey(match));
    return block ? [{ ...match, block }] : [];
  });
}
