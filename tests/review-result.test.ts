import assert from "node:assert/strict";
import test from "node:test";
import { evaluationResultSchema } from "../lib/llm/schemas";
import { evaluateQuestionWithChunks, resolveModelAssessment } from "../lib/rag/evaluation";
import { unresolvedEvaluation } from "../lib/review-result";
import type { AuditQuestion, PolicyChunk } from "../types/compliance";

const question: AuditQuestion = { id: "q1", order: 1, text: "Is a second reviewer required?" };
const policy: PolicyChunk = {
  chunkId: "clause",
  documentId: "policy",
  fileName: "synthetic-policy.pdf",
  pageNumber: 4,
  sourceType: "uploaded",
  text: "A single reviewer may approve the test record.",
};

test("an evaluated No requires a matching quotation from the cited page", () => {
  const valid = {
    answer: "No" as const,
    reason: "The policy allows one reviewer.",
    confidence: "High" as const,
    citation: { chunkId: policy.chunkId, snippet: policy.text },
  };
  const contradicted = resolveModelAssessment(question, [policy], valid);
  assert.equal(contradicted.status, "evaluated");
  assert.equal(contradicted.answer, "No");
  assert.equal(contradicted.sourcePage, 4);

  const untraceable = resolveModelAssessment(question, [policy], {
    ...valid, citation: { ...valid.citation, snippet: "An invented quote." },
  });
  assert.equal(untraceable.status, "insufficient");
  assert.equal(untraceable.answer, null);
  assert.equal(untraceable.retrievedChunks[0]?.isPrimary, false);
});

test("an empty retrieval and a processing error carry different states and no answer", async () => {
  const insufficient = await evaluateQuestionWithChunks({ question, chunks: [] });
  const failed = unresolvedEvaluation(question, "failed");
  assert.equal(insufficient.status, "insufficient");
  assert.equal(failed.status, "failed");
  for (const result of [insufficient, failed]) {
    assert.equal(result.answer, null);
    assert.equal(evaluationResultSchema.safeParse(result).success, true);
    assert.equal(evaluationResultSchema.safeParse({ ...result, answer: "No" }).success, false);
  }
});
