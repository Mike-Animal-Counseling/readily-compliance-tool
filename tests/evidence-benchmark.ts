import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { createClient } from "../examples/readily-v1/client";
import { extractPdfPagesFromBuffer } from "../lib/pdf/extract-pages";
import { chunkPolicyDocument } from "../lib/rag/chunking";
import { retrieveRelevantChunks } from "../lib/rag/retrieval";
import { vectorizePolicyChunks } from "../lib/rag/vector-store";
import type { ParentBlock } from "../lib/evidence/model";
import { parsePolicy } from "../lib/evidence/layout";
import { development, evidenceCorpus, holdout } from "./fixtures/evidence-corpus";

export async function benchmark(client: ReturnType<typeof createClient>) {
  const pdf = evidenceCorpus();
  const document = await client.upload(pdf, { documentKey: "corpus", fileName: "benchmark.pdf", effectiveFrom: "2020-01-01" }, "corpus");
  const snapshot = await client.index([document.id], "corpus-index");
  await client.activate(snapshot.id, null, "activate-corpus");
  const pages = await extractPdfPagesFromBuffer(pdf);
  const baseline = vectorizePolicyChunks(chunkPolicyDocument({
    documentId: "corpus", pages, fileName: "benchmark.pdf", sourceType: "uploaded",
  }));
  const blocks = new Map<string, ParentBlock>();
  const candidateTerms = new Map((await parsePolicy(pdf)).parents.map(block =>
    [block.id, words(block.units.map(unit => unit.text).join(" "))]));
  for (const [name, cases] of [["development", development], ["holdout", holdout]] as const) {
    let baselineHits = 0, hits = 0, covered = 0, citations = 0, accurate = 0, supported = 0;
    let exceptionTotal = 0, exceptionsCovered = 0, conditionalHits = 0;
    let reciprocalRank = 0, rerankedReciprocalRank = 0;
    const timings: number[] = [];
    for (const [index, item] of cases.entries()) {
      const started = performance.now();
      const report = await client.evaluate(item.question, `${name}-${index}`, "2023-06-01");
      timings.push(performance.now() - started);
      const { result } = report;
      const retrieved = result.parents.filter(parent => parent.hits.length > 0);
      assert.ok(retrieved.length <= 5);
      const target = retrieved.find(parent => parent.documentVersionId === document.id && parent.parentId === item.parentId);
      if (target) {
        hits++;
        reciprocalRank += 1 / (retrieved.indexOf(target) + 1);
        const terms = [...words(item.question)];
        const reranked = retrieved.map(parent => ({
          parent, score: terms.filter(term => candidateTerms.get(parent.parentId)?.has(term)).length,
        })).sort((a, b) => b.score - a.score);
        rerankedReciprocalRank += 1 / (reranked.findIndex(item => item.parent === target) + 1);
      }
      if (retrieveRelevantChunks(item.question, baseline, 5).some(chunk => chunk.text.includes(item.quote))) baselineHits++;

      // Independently verify the labeled source in the complete evidence returned
      // for a gold lookup, so chunk coverage is not conditioned on ranking.
      let block = blocks.get(item.parentId);
      if (!block) {
        const gold = await client.evaluate(`Show section ${item.parentId.slice(1)}.1`, `gold-${item.parentId}`, "2023-06-01");
        const result = await client.json<{ block: ParentBlock }>(`/reports/${gold.id}/evidence/${document.id}/${item.parentId}`);
        block = result.block;
        blocks.set(item.parentId, block);
      }
      if (block.units.some(unit => unit.text.includes(item.quote))) covered++;

      const claimCitations = result.claims.flatMap(claim => claim.evidence);
      let goldCited = false;
      for (const reference of claimCitations) {
        citations++;
        const location = await client.locate(report.id, reference);
        if (reference.documentVersionId === document.id && reference.parentId === item.parentId &&
            location.unit.text.includes(reference.quote)) accurate++;
        if (reference.quote.includes(item.quote)) goldCited = true;
      }
      if (result.status === "supported" && goldCited) supported++;
      if (item.exception) {
        exceptionTotal++;
        if (target) conditionalHits++;
        const expected = item.exception;
        if (result.exceptions.some(exception => exception.parentId === item.parentId && exception.quote.includes(expected))) {
          assert.equal(result.status, "needs_review");
          exceptionsCovered++;
        }
      }
    }
    timings.sort((a, b) => a - b);
    console.log(JSON.stringify({
      benchmark: name,
      cases: cases.length,
      baselineRecallAt5: baselineHits / cases.length,
      recallAt5: hits / cases.length,
      relativeRecallLift: baselineHits ? (hits - baselineHits) / baselineHits : null,
      meanReciprocalRank: reciprocalRank / cases.length,
      lexicalRerankMeanReciprocalRank: rerankedReciprocalRank / cases.length,
      chunkCoverage: covered / cases.length,
      citationAccuracy: citations ? accurate / citations : null,
      citationCount: citations,
      exceptionCoverage: exceptionTotal ? exceptionsCovered / exceptionTotal : null,
      conditionalCoverageAfterHit: conditionalHits ? exceptionsCovered / conditionalHits : null,
      evidenceSupportedRate: supported / cases.length,
      latencyP95Ms: Math.round(timings[Math.ceil(timings.length * 0.95) - 1]),
      providerCost: 0,
    }));
    assert.ok(covered / cases.length >= 0.9, "Evidence coverage regression");
    assert.ok(citations && accurate / citations >= 0.95, "Quote and citation regression");
    if (exceptionTotal) assert.equal(exceptionsCovered, exceptionTotal, "Critical exception omitted");
  }
}

function words(text: string) {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => word.length > 2));
}
