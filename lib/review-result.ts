import type {
  AuditQuestion,
  EvaluationResult,
  RetrievedEvidenceChunk,
} from "@/types/compliance";

export function unresolvedEvaluation(
  question: AuditQuestion,
  status: "failed" | "insufficient",
  reason?: string,
  retrievedChunks: RetrievedEvidenceChunk[] = [],
): EvaluationResult {
  const details = {
    questionId: question.id,
    questionText: question.text,
    answer: null,
    confidence: null,
    evidence: "",
    evidenceChunkText: "",
    retrievedChunks,
    sourceFile: "",
    sourcePage: 0,
    sourceType: null,
  };

  return status === "failed"
    ? { ...details, status, reason: "Question evaluation failed. Re-run the question to try again.", reviewState: "pending" }
    : { ...details, status, reason: reason || "The retrieved policies did not contain enough evidence.", reviewState: "needs_review" };
}
