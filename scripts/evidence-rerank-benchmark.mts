import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { assess } from "../lib/evidence/assessment";
import type { Assessment, EvidenceCitation } from "../lib/evidence/assessment";
import { evidenceDb } from "../lib/evidence/connection";
import { clauseReferences } from "../lib/evidence/layout";
import type { EvidenceCell, EvidenceUnit, ParentBlock, SourceBox } from "../lib/evidence/model";
import { locateEvidence } from "../lib/evidence/operations";
import { parentKey } from "../lib/evidence/parents";
import { activateSnapshot, buildSnapshot, createDocument, findParents, readParents } from "../lib/evidence/repository";
import { isLocalRerankerConfigured, scoreLocalReranker } from "../lib/evidence/reranker";
import type { RerankPassage } from "../lib/evidence/reranker";
import { rerankingCorpus } from "../tests/fixtures/reranking-corpus";
import type { RerankingCase } from "../tests/fixtures/reranking-corpus";

const database = process.env.READILY_V1_TEST_DATABASE_URL;
if (!database) throw new Error("Set READILY_V1_TEST_DATABASE_URL to a disposable local PostgreSQL database");
const url = new URL(database);
assert.ok(["postgres:", "postgresql:"].includes(url.protocol) &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/readily_v1_test",
  "Use the readily_v1_test database on loopback");
process.env.READILY_V1_DATABASE_URL = database;

const sql = evidenceDb();
const tenant = randomUUID();
const asOf = "2024-01-01";
const topK = 5;
const poolSize = 20;
const deployedDeadlineMs = 2500;
const timeout = process.env.READILY_V1_RERANK_BENCHMARK_TIMEOUT_MS;
const benchmarkDeadlineMs = timeout === undefined ? undefined : Number(timeout);
assert.ok(benchmarkDeadlineMs === undefined || (Number.isInteger(benchmarkDeadlineMs) &&
  benchmarkDeadlineMs >= deployedDeadlineMs && benchmarkDeadlineMs <= 60000),
  "READILY_V1_RERANK_BENCHMARK_TIMEOUT_MS must be an integer between 2500 and 60000");
assert.ok(benchmarkDeadlineMs === undefined || isLocalRerankerConfigured(),
  "The offline comparison requires valid loopback reranker settings");
const splitFilter = process.env.READILY_V1_RERANK_BENCHMARK_SPLIT;
assert.ok(splitFilter === undefined || splitFilter === "development" || splitFilter === "holdout",
  "READILY_V1_RERANK_BENCHMARK_SPLIT must be development or holdout");
const benchmarkScorer = benchmarkDeadlineMs === undefined ? undefined : (question: string, passages: RerankPassage[]) =>
  scoreLocalReranker(question, passages, undefined, benchmarkDeadlineMs);
let tenantCreated = false;

type Location = { documentVersionId: string; parentId: string; source: string; unit: EvidenceUnit; cell?: EvidenceCell };
type Mode = "baseline" | "configured";
type Outcome = {
  assessment: Assessment;
  ranks: number[];
  elapsedMs: number;
  citations: number;
  validCitations: number;
  goldQuotesAvailable: number;
  exceptionParentRetrieved: boolean;
  goldExceptionLocated: boolean;
};
type Trial = { item: RerankingCase; candidateRanks: number[] } & Record<Mode, Outcome>;

function validBox(box: SourceBox, pageCount: number) {
  return Number.isInteger(box.page) && box.page >= 1 && box.page <= pageCount &&
    box.left >= 0 && box.left < box.right && box.right <= 1 && box.top >= 0 && box.top < box.bottom && box.bottom <= 1;
}

function ranked(assessment: Assessment) {
  return assessment.parents.filter(parent => parent.hits.length);
}

function goldRanks(parentIds: string[], item: RerankingCase) {
  return item.goldParentIds.map(id => parentIds.indexOf(id) + 1);
}

async function assessCase(item: RerankingCase, documentVersionId: string, pageCount: number, snapshotId: string, mode: Mode): Promise<Outcome> {
  const started = performance.now();
  const assessment = await sql.begin(async tx => {
    if (mode === "configured" && benchmarkDeadlineMs !== undefined) {
      await tx`select set_config('idle_in_transaction_session_timeout', ${String(benchmarkDeadlineMs + 5000)}, true)`;
    }
    return assess(tx, tenant, snapshotId, asOf, item.question, mode === "configured", benchmarkScorer);
  });
  const elapsedMs = performance.now() - started;
  const report = randomUUID();
  await sql`insert into readily_v1.reports (tenant_id, id, snapshot_id, as_of, result)
    values (${tenant}, ${report}, ${snapshotId}, ${asOf}, ${sql.json(assessment)})`;

  const citations = [...assessment.claims.flatMap(claim => claim.evidence), ...assessment.excerpts, ...assessment.exceptions];
  const locations = new Map<EvidenceCitation, Location>();
  for (const citation of citations) {
    const { documentVersionId: version, parentId, unitId, column, quote } = citation;
    const response = await locateEvidence(tenant, report, version, parentId, unitId, column?.toString());
    const location = await response.json() as Location;
    const { unit, cell } = location;
    const source = `/api/v1/documents/${documentVersionId}/source`;
    if (version === documentVersionId && location.documentVersionId === version &&
        location.parentId === parentId && location.source === source && unit.id === unitId &&
        (column === undefined || cell?.column === column) && (cell?.text ?? unit.text).includes(quote) &&
        (cell ? validBox(cell.box, pageCount) : unit.boxes.length > 0 && unit.boxes.every(box => validBox(box, pageCount)))) {
      locations.set(citation, location);
    }
  }

  const parents = ranked(assessment);
  const keys = parents.map(parentKey);
  assert.ok(keys.length <= topK, `[${item.id} ${mode}] Returned more than ${topK} parents`);
  assert.equal(new Set(keys).size, keys.length, `[${item.id} ${mode}] Returned duplicate parents`);
  const parentIds = parents.filter(parent => parent.documentVersionId === documentVersionId).map(parent => parent.parentId);

  const blocks = new Map<string, ParentBlock>();
  for (const parentId of item.goldParentIds.filter(id => parentIds.includes(id))) {
    const response = await locateEvidence(tenant, report, documentVersionId, parentId);
    const { block } = await response.json() as { block: ParentBlock };
    assert.equal(block.id, parentId);
    blocks.set(parentId, block);
  }
  const goldQuotesAvailable = item.goldEvidence.filter(({ parentId, quote }) =>
    blocks.get(parentId)?.units.some(unit => unit.text.includes(quote))).length;
  const exceptionText = item.exceptionText;
  const exceptionParent = exceptionText && item.goldEvidence.find(({ quote }) => quote.includes(exceptionText))?.parentId;
  const goldExceptionLocated = !!exceptionText && !!exceptionParent && assessment.exceptions.some(citation =>
    citation.parentId === exceptionParent && citation.quote.includes(exceptionText) && locations.get(citation)?.unit.exception);

  return {
    assessment, elapsedMs, ranks: goldRanks(parentIds, item), citations: citations.length, validCitations: locations.size,
    goldQuotesAvailable, goldExceptionLocated, exceptionParentRetrieved: !!exceptionParent && parentIds.includes(exceptionParent),
  };
}

function fraction(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

function rankReciprocal(ranks: number[]) {
  const hit = Math.min(...ranks.filter(rank => rank > 0));
  return 1 / hit;
}

function summarize(trials: Trial[], mode: Mode) {
  const positives = trials.filter(({ item }) => item.goldParentIds.length).map(trial => trial[mode]);
  const outcomes = trials.map(trial => trial[mode]);
  const exceptions = trials.filter(({ item }) => item.exceptionText).map(trial => trial[mode]);
  const negatives = trials.filter(({ item }) => !item.goldParentIds.length).map(trial => trial[mode]);
  const statuses: Assessment["status"][] = ["insufficient", "needs_review", "supported"];
  const timings = outcomes.map(outcome => outcome.elapsedMs).sort((a, b) => a - b);
  const sum = (select: (outcome: Outcome) => number) => outcomes.reduce((total, outcome) => total + select(outcome), 0);
  return {
    parentRecallAt5: fraction(positives.flatMap(({ ranks }) => ranks).filter(Boolean).length,
      positives.reduce((count, { ranks }) => count + ranks.length, 0)),
    allGoldParentsAt5: fraction(positives.filter(({ ranks }) => ranks.every(Boolean)).length, positives.length),
    meanReciprocalRank: fraction(positives.reduce((total, { ranks }) => total + rankReciprocal(ranks), 0), positives.length),
    locatedCitationCount: sum(outcome => outcome.citations),
    citationAccuracy: fraction(sum(outcome => outcome.validCitations), sum(outcome => outcome.citations)),
    goldQuoteCoverage: fraction(sum(outcome => outcome.goldQuotesAvailable), trials.flatMap(({ item }) => item.goldEvidence).length),
    exceptionCoverage: fraction(exceptions.filter(outcome => outcome.goldExceptionLocated).length, exceptions.length),
    exceptionCoverageWhenParentRetrieved: fraction(exceptions.filter(outcome => outcome.goldExceptionLocated).length,
      exceptions.filter(outcome => outcome.exceptionParentRetrieved).length),
    exceptionLocatedAndReviewed: fraction(exceptions.filter(outcome => outcome.goldExceptionLocated &&
      outcome.assessment.status === "needs_review").length, exceptions.length),
    modelRuns: outcomes.filter(({ assessment }) => assessment.retrieval?.method === "cross_encoder").length,
    modelRunsWithAssessmentWithinDeployedDeadline: outcomes.filter(({ assessment, elapsedMs }) =>
      assessment.retrieval?.method === "cross_encoder" && elapsedMs <= deployedDeadlineMs).length,
    fallbacks: Object.fromEntries(["missing_passages", "model_unavailable"].map(reason => [reason,
      outcomes.filter(({ assessment }) => assessment.retrieval?.method === "rrf" && assessment.retrieval.fallback === reason).length])),
    assessmentP95Ms: timings.length ? Math.round(timings[Math.ceil(timings.length * 0.95) - 1]) : null,
    negativeStatuses: Object.fromEntries(statuses.map(status => [status, negatives.filter(outcome => outcome.assessment.status === status).length])),
  };
}

async function migrate(databaseUrl: string) {
  const migrationSql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const [schema] = await migrationSql`select to_regclass('readily_v1.reviews') is not null as migrated`;
    if (!schema.migrated) {
      await migrationSql.unsafe(await readFile(new URL("../db/migrations/001_versioned_evidence.sql", import.meta.url), "utf8"));
    }
    const [reviewAnswers] = await migrationSql`select exists (select 1 from information_schema.columns
      where table_schema = 'readily_v1' and table_name = 'reviews' and column_name = 'answer_override') as migrated`;
    if (!reviewAnswers.migrated) {
      await migrationSql.unsafe(await readFile(new URL("../db/migrations/002_review_answers.sql", import.meta.url), "utf8"));
    }
    await migrationSql.unsafe(await readFile(new URL("../db/migrations/003_rerank_passages.sql", import.meta.url), "utf8"));
  } finally {
    await migrationSql.end({ timeout: 5 });
  }
}

try {
  await migrate(database);
  const { doc, snapshot } = await sql.begin(async tx => {
    await tx`insert into readily_v1.tenants (id, enabled) values (${tenant}, true)`;
    const doc = await createDocument(tx, tenant, {
      bytes: rerankingCorpus.pdf(), documentKey: "synthetic-reranking", fileName: "freight-handbook.pdf", effectiveFrom: "2020-01-01",
    });
    assert.equal(doc.status, "ready");
    const snapshot = await buildSnapshot(tx, tenant, [doc.id]);
    await activateSnapshot(tx, tenant, snapshot.id, null);

    const ids = [...new Set(rerankingCorpus.cases.flatMap(item => item.goldParentIds))];
    const parents = await readParents(tx, tenant, ids.map(parentId => ({ documentVersionId: doc.id, parentId, hits: [], score: 0 })));
    const blocks = new Map(parents.map(({ parentId, block }) => [parentId, block]));
    for (const item of rerankingCorpus.cases) {
      for (const { parentId, quote } of item.goldEvidence) {
        assert.ok(blocks.get(parentId)?.units.some(unit => unit.text.includes(quote)), `[${item.id}] Missing gold source quote`);
      }
      const exception = item.exceptionText;
      if (exception) {
        assert.ok(item.goldParentIds.some(parentId => blocks.get(parentId)?.units.some(unit =>
          unit.exception && unit.text.includes(exception))), `[${item.id}] Missing gold exception`);
      }
    }
    return { doc, snapshot };
  });
  tenantCreated = true;

  const trials: Trial[] = [];
  for (const item of rerankingCorpus.cases.filter(item => !splitFilter || item.split === splitFilter)) {
    const candidates = await sql.begin(tx => findParents(tx, tenant, snapshot.id, asOf, item.question, clauseReferences(item.question), poolSize));
    const candidateKeys = candidates.map(parentKey);
    const candidateRanks = goldRanks(candidates.filter(parent => parent.documentVersionId === doc.id).map(parent => parent.parentId), item);
    const baseline = await assessCase(item, doc.id, doc.pageCount, snapshot.id, "baseline");
    const configured = await assessCase(item, doc.id, doc.pageCount, snapshot.id, "configured");
    assert.deepEqual(ranked(baseline.assessment).map(parentKey), candidateKeys.slice(0, topK), `[${item.id}] Baseline top 5 diverged from pool`);
    const configuredKeys = ranked(configured.assessment).map(parentKey);
    assert.ok(configuredKeys.every(key => candidateKeys.includes(key)), `[${item.id}] Reranker left the common candidate pool`);
    if (configured.assessment.retrieval?.method !== "cross_encoder") {
      assert.deepEqual(configuredKeys, candidateKeys.slice(0, topK), `[${item.id}] RRF fallback changed selected parents`);
    }
    trials.push({ item, candidateRanks, baseline, configured });
  }

  for (const split of ["development", "holdout"] as const) {
    const items = trials.filter(({ item }) => item.split === split);
    if (!items.length) continue;
    const gold = items.flatMap(({ candidateRanks }) => candidateRanks);
    console.log(JSON.stringify({
      benchmark: "reranking", split, cases: items.length, positiveCases: items.filter(({ item }) => item.goldParentIds.length).length,
      rerankerDeadlineMs: benchmarkDeadlineMs ?? deployedDeadlineMs,
      deployedRerankerDeadlineMs: deployedDeadlineMs,
      candidateParentRecallAt20: fraction(gold.filter(Boolean).length, gold.length),
      baseline: summarize(items, "baseline"), configured: summarize(items, "configured"),
      modelVersions: [...new Set(items.flatMap(({ configured }) => {
        const retrieval = configured.assessment.retrieval;
        return retrieval?.method === "cross_encoder" ? [retrieval.model] : [];
      }))],
      ranks: items.map(({ item, candidateRanks, baseline, configured }) => ({
        id: item.id, candidateRanks, baseline: baseline.ranks, configured: configured.ranks,
      })),
    }));
  }

  for (const { item, baseline, configured } of trials) {
    for (const outcome of [baseline, configured]) {
      assert.equal(outcome.validCitations, outcome.citations, `[${item.id}] A citation did not round-trip`);
      if (outcome.goldExceptionLocated) assert.equal(outcome.assessment.status, "needs_review", `[${item.id}] Exception skipped review`);
      if (!item.goldParentIds.length) assert.notEqual(outcome.assessment.status, "supported", `[${item.id}] Unsupported question was accepted`);
    }
  }
  if (benchmarkDeadlineMs !== undefined) {
    assert.ok(trials.some(({ configured }) => configured.assessment.retrieval?.method === "cross_encoder"),
      "The configured local model did not complete any assessment");
  }
} finally {
  try {
    if (tenantCreated) {
      const deleted = await sql`delete from readily_v1.tenants where id = ${tenant} returning id`;
      assert.equal(deleted.length, 1);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
