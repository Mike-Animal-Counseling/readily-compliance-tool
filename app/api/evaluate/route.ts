import { guardApi } from "@/lib/security/api";
import { requestSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { getDataset } from "@/lib/data/dataset-store";
import { searchPreloadedPolicyChunks } from "@/lib/db/preloaded-policy-store";
import { evaluateReviewRequestSchema } from "@/lib/llm/schemas";
import { evaluateQuestionWithChunks } from "@/lib/rag/evaluation";
import { unresolvedEvaluation } from "@/lib/review-result";
import type { VectorizedPolicyChunk } from "@/lib/rag/vector-store";
import type { EvaluateResponse } from "@/types/compliance";

export const runtime = "nodejs";

function getPositiveIntEnv(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

const EVALUATION_CONCURRENCY = getPositiveIntEnv("EVALUATION_CONCURRENCY", 3);

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
) {
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function handlePOST(request: Request) {
  try {
    const body = await request.json();
    const parsedBody = evaluateReviewRequestSchema.parse(body);

    if (parsedBody.questions.length === 0) {
      return NextResponse.json(
        { error: "Add at least one audit question before running review." },
        { status: 400 },
      );
    }

    const uploadedChunks: VectorizedPolicyChunk[] = [];

    if (parsedBody.uploadedDatasetId) {
      const dataset = await getDataset(parsedBody.uploadedDatasetId, (await requestSession(request))!.sid);
      if (!dataset) {
        return NextResponse.json(
          {
            error:
              "The uploaded policy dataset is no longer available. Re-parse the uploaded PDFs and try again.",
          },
          { status: 410 },
        );
      }

      const allowedDocumentIds =
        parsedBody.selectedDocumentIds.length > 0
          ? new Set(parsedBody.selectedDocumentIds)
          : new Set(dataset.documents.map((document) => document.id));

      uploadedChunks.push(
        ...dataset.chunks.filter((chunk) => allowedDocumentIds.has(chunk.documentId)),
      );
    }

    if (!parsedBody.useDefaultPolicyLibrary && uploadedChunks.length === 0) {
      return NextResponse.json(
        {
          error:
            "Enable the default policy library or select at least one uploaded policy document to review against.",
        },
        { status: 400 },
      );
    }

    const results = await mapWithConcurrency(
      parsedBody.questions,
      EVALUATION_CONCURRENCY,
      async (question) => {
        try {
          const defaultLibraryChunks = parsedBody.useDefaultPolicyLibrary
            ? await searchPreloadedPolicyChunks(question.text, 20)
            : [];
          const combinedChunks = [...defaultLibraryChunks, ...uploadedChunks];

          return await evaluateQuestionWithChunks({
            question,
            chunks: combinedChunks,
          });
        } catch {
          console.error("[evaluate] question failed", {
            questionId: question.id,
            message:
              "Request could not be completed.",
          });

          return unresolvedEvaluation(question, "failed");
        }
      },
    );

    const response: EvaluateResponse = { results };
    return NextResponse.json(response);
  } catch {
    const message =
      "Request could not be completed.";

    console.error("[evaluate] failed", {
      message,
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = guardApi(handlePOST, true);
