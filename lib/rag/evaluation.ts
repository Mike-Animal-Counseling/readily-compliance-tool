import { evaluationModelResponseSchema } from "@/lib/llm/schemas";
import { buildEvaluationPrompt } from "@/lib/llm/prompts";
import { callOpenRouterJson } from "@/lib/llm/openrouter";
import { retrieveRelevantChunks } from "@/lib/rag/retrieval";
import { unresolvedEvaluation } from "@/lib/review-result";
import type { VectorizedPolicyChunk } from "@/lib/rag/vector-store";
import type { AuditQuestion, EvaluationResult, PolicyChunk } from "@/types/compliance";
import type { z } from "zod";

const configuredTimeout = Number(process.env.EVALUATION_LLM_TIMEOUT_MS);
const EVALUATION_LLM_TIMEOUT_MS = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : 20000;
const EVALUATION_MODEL = process.env.OPENROUTER_REVIEW_MODEL ?? process.env.OPENROUTER_MODEL;

export function resolveModelAssessment(
  question: AuditQuestion,
  retrieved: PolicyChunk[],
  assessment: z.infer<typeof evaluationModelResponseSchema>,
): EvaluationResult {
  const citation = assessment.citation;
  const snippet = citation?.snippet.trim() ?? "";
  const cited = citation && snippet ? retrieved.find((chunk) =>
    chunk.chunkId === citation.chunkId && chunk.text.includes(snippet),
  ) : undefined;
  const primaryId = assessment.answer !== null ? cited?.chunkId : undefined;
  const retrievedChunks = retrieved.map((chunk) => ({
    chunkId: chunk.chunkId,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    sourceType: chunk.sourceType,
    text: chunk.text,
    isPrimary: chunk.chunkId === primaryId,
  }));
  if (assessment.answer === null) {
    return unresolvedEvaluation(question, "insufficient", assessment.reason.trim(), retrievedChunks);
  }
  if (!cited) {
    return unresolvedEvaluation(question, "insufficient", "The proposed answer could not be traced to an exact quote from the retrieved policies.", retrievedChunks);
  }

  return {
    status: "evaluated",
    questionId: question.id,
    questionText: question.text,
    answer: assessment.answer,
    reason: assessment.reason.trim(),
    evidence: snippet,
    confidence: assessment.confidence,
    evidenceChunkText: cited.text,
    retrievedChunks,
    sourceFile: cited.fileName,
    sourcePage: cited.pageNumber,
    sourceType: cited.sourceType,
    reviewState: "pending",
  };
}

export async function evaluateQuestionWithChunks({
  question,
  chunks,
}: {
  question: AuditQuestion;
  chunks: VectorizedPolicyChunk[];
}): Promise<EvaluationResult> {
  const retrievedChunks = retrieveRelevantChunks(question.text, chunks, 5);
  if (retrievedChunks.length === 0) return unresolvedEvaluation(question, "insufficient");

  const prompt = buildEvaluationPrompt({ question: question.text, chunks: retrievedChunks });
  const assessment = await callOpenRouterJson({
    responseLabel: "question evaluation for " + question.id,
    schema: evaluationModelResponseSchema,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    model: EVALUATION_MODEL,
    maxTokens: 700,
    timeoutMs: EVALUATION_LLM_TIMEOUT_MS,
  });
  return resolveModelAssessment(question, retrievedChunks, assessment);
}
