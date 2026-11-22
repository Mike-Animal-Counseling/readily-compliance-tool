import { clauseReferences } from "./layout";
import { parentKey } from "./parents";
import { findParents, readRerankPassages } from "./repository";
import type { Transaction } from "./repository";
import { isLocalRerankerConfigured, scoreLocalReranker } from "./reranker";

export type Retrieval =
  | { method: "rrf"; fallback?: "missing_passages" | "model_unavailable" }
  | { method: "cross_encoder"; model: string };

const parentLimit = 5;
const candidateLimit = 20;

export async function retrieveAssessmentParents(
  sql: Transaction, tenant: string, snapshot: string, asOf: string, question: string, allowRerank: boolean,
  score = scoreLocalReranker,
) {
  const clauses = clauseReferences(question);
  // Preserve deterministic clause-number retrieval, including shared clause numbers across documents.
  const enabled = allowRerank && !clauses.length && isLocalRerankerConfigured();
  const candidates = await findParents(sql, tenant, snapshot, asOf, question, clauses, enabled ? candidateLimit : parentLimit);
  const baseline = candidates.slice(0, parentLimit);
  const baselineResult = (fallback?: "missing_passages" | "model_unavailable") => ({
    matches: baseline, retrieval: { method: "rrf" as const, ...(fallback ? { fallback } : {}) },
  });
  if (!enabled || candidates.length < 2) return baselineResult();

  const rows = await readRerankPassages(sql, tenant, snapshot, candidates);
  const passages = new Map(rows.map(row => [parentKey(row), row.text.slice(0, 1200).replace(/[\uD800-\uDBFF]$/u, "")]));
  const ordered = candidates.flatMap(candidate => {
    const key = parentKey(candidate);
    const text = passages.get(key);
    return text?.trim() ? [{ key, text }] : [];
  });
  if (ordered.length !== candidates.length) return baselineResult("missing_passages");
  const result = await score(question, ordered);
  if (!result) return baselineResult("model_unavailable");

  const ranked = candidates.map((candidate, index) => ({ candidate, score: result.scores[index], index }));
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const retrieval: Retrieval = { method: "cross_encoder", model: result.version };
  return { matches: ranked.slice(0, parentLimit).map(row => row.candidate), retrieval };
}
