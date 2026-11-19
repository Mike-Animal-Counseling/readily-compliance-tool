import { clauseReferences } from "./layout";
import type { EvidenceUnit } from "./model";
import { parentBatches, parentKey } from "./parents";
import type { ParentMatch, ReadParent } from "./parents";
import { findParents, findReferencedParents, readParents } from "./repository";
import type { Transaction } from "./repository";

export type EvidenceCitation = {
  documentVersionId: string;
  parentId: string;
  unitId: string;
  quote: string;
  column?: number;
};

export type Assessment = {
  question: string;
  status: "supported" | "insufficient" | "needs_review";
  reasons: string[];
  parents: ParentMatch[];
  claims: { statement: string; evidence: EvidenceCitation[] }[];
  excerpts: EvidenceCitation[];
  exceptions: EvidenceCitation[];
  batchesRead: number;
};

function citation(parent: ParentMatch, unit: EvidenceUnit, quote: string): EvidenceCitation {
  const cell = unit.table?.cells.find(cell => cell.text.includes(quote));
  return {
    documentVersionId: parent.documentVersionId, parentId: parent.parentId, unitId: unit.id, quote,
    ...(cell ? { column: cell.column } : {}),
  };
}

async function readReferences(sql: Transaction, tenant: string, snapshot: string, asOf: string, selected: ReadParent[]) {
  const seen = new Map(selected.map(parent => [parentKey(parent), parent]));
  let unresolved = false;
  let pending = selected;
  while (pending.length) {
    const references = pending.flatMap(parent => [...new Set(parent.block.units.flatMap(unit => unit.references))]
      .map(clause => ({ version: parent.documentVersionId, clause })));
    if (!references.length) break;
    const locations = await findReferencedParents(sql, tenant, snapshot, asOf, [...new Set(references.map(ref => ref.clause))]);
    const additions = new Map<string, ParentMatch>();
    for (const { version, clause } of references) {
      const matching = locations.filter(location => location.clause === clause);
      const sameVersion = matching.filter(location => location.documentVersionId === version);
      const options = sameVersion.length ? sameVersion : matching;
      if (options.length !== 1) {
        unresolved = true;
        continue;
      }
      const { documentVersionId, parentId } = options[0];
      if (!seen.has(parentKey(options[0]))) additions.set(parentKey(options[0]), { documentVersionId, parentId, hits: [], score: 0 });
    }
    if (seen.size + additions.size > 12) {
      unresolved = true;
      break;
    }
    pending = await readParents(sql, tenant, [...additions.values()]);
    if (pending.length !== additions.size) unresolved = true;
    for (const parent of pending) seen.set(parentKey(parent), parent);
  }
  return { parents: [...seen.values()], unresolved };
}

export function readAssessment(question: string, parents: ReadParent[], initialReasons: string[]): Assessment {
  const reasons = new Set(initialReasons);
  const lookup = question.match(/^(?:what does|quote|show)\s+(?:section|clause|article)\s+(\d{1,3}(?:\.\d{1,3}){0,7})(?:\s+state)?[.?!]?$/i)?.[1];
  const exact = new Map<string, EvidenceCitation>();
  const exceptions = new Map<string, EvidenceCitation>();
  const excerpts = new Map<string, EvidenceCitation>();
  let batchesRead = 0;
  for (const parent of parents) {
    const hitIds = new Set(parent.hits.flatMap(hit => hit.unitIds));
    let excerptCount = 0;
    for (const batch of parentBatches(parent.block)) {
      batchesRead++;
      for (const unit of batch) {
        if (!unit.text.trim()) continue;
        const key = `${parentKey(parent)}/${unit.id}`;
        if (lookup && (unit.clause === lookup || unit.clause?.startsWith(lookup + "."))) {
          exact.set(key, citation(parent, unit, unit.text));
        }
        if (unit.exception && !exceptions.has(key)) {
          exceptions.set(key, citation(parent, unit, unit.text.slice(0, 240)));
        }
        if (hitIds.has(unit.id) && excerptCount < 3 && !excerpts.has(key)) {
          excerpts.set(key, citation(parent, unit, unit.text.slice(0, 240)));
          excerptCount++;
        }
      }
    }
  }
  const matches = [...exact.values()];
  const versions = new Set(matches.map(match => match.documentVersionId));
  if (versions.size > 1) reasons.add("ambiguous_clause");
  if (exceptions.size) reasons.add("condition_requires_review");
  if (parents.length && !lookup) reasons.add("interpretation_requires_review");
  if (matches.length > 40 || matches.reduce((length, match) => length + match.quote.length, 0) > 16000) {
    reasons.add("quotation_exceeds_report_limit");
  }
  if (exceptions.size > 40) reasons.add("exception_list_exceeds_report_limit");
  const claims = reasons.size ? [] : matches.map(evidence => ({ statement: evidence.quote, evidence: [evidence] }));
  return {
    question,
    status: reasons.size ? "needs_review" : claims.length ? "supported" : "insufficient",
    reasons: [...reasons],
    parents: parents.map(({ documentVersionId, parentId, score, hits }) => ({ documentVersionId, parentId, score, hits })),
    claims,
    excerpts: [...excerpts.values()],
    exceptions: [...exceptions.values()].slice(0, 40),
    batchesRead,
  };
}

export async function assess(sql: Transaction, tenant: string, snapshot: string, asOf: string, question: string): Promise<Assessment> {
  const matches = await findParents(sql, tenant, snapshot, asOf, question, clauseReferences(question));
  const selected = await readParents(sql, tenant, matches);
  const { parents, unresolved } = await readReferences(sql, tenant, snapshot, asOf, selected);
  const [unreadable] = await sql`
    select 1 from readily_v1.snapshot_documents s join readily_v1.document_versions d
      on d.tenant_id = s.tenant_id and d.id = s.document_version_id
    where s.tenant_id = ${tenant} and s.snapshot_id = ${snapshot}
      and daterange(d.effective_from, d.effective_until) @> ${asOf}::date
      and jsonb_array_length(d.warnings) > 0 limit 1
  `;
  const reasons = [];
  if (unreadable) reasons.push("unverified_pdf_layout");
  if (unresolved) reasons.push("unresolved_clause_reference");
  if (selected.length !== matches.length) reasons.push("missing_parent");
  return readAssessment(question, parents, reasons);
}
