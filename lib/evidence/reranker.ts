import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { z } from "zod";

export type RerankPassage = { key: string; text: string };

const maxPassages = 20;
const maxPassageLength = 1200;
const maxRequestBytes = 128 * 1024;
const maxResponseBytes = 16 * 1024;
const payload = z.object({
  results: z.array(z.object({
    index: z.number().int().min(0).max(maxPassages - 1),
    relevance_score: z.number(),
  })).max(maxPassages),
});

let busy = false;

function localConfiguration() {
  const configuredPort = process.env.READILY_V1_RERANK_PORT;
  const token = process.env.READILY_V1_RERANK_TOKEN;
  const version = process.env.READILY_V1_RERANK_MODEL;
  const port = Number(configuredPort);
  if (!configuredPort || !/^[0-9]{1,5}$/.test(configuredPort) || port < 1 || port > 65535 ||
      !token || !/^[A-Za-z0-9_-]{32,256}$/.test(token) ||
      !version || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}$/.test(version)) return null;
  return { port, token, version };
}

export function isLocalRerankerConfigured(): boolean {
  return localConfiguration() !== null;
}

export async function scoreLocalReranker(question: string, passages: RerankPassage[], signal?: AbortSignal, deadlineMs = 2500):
  Promise<{ scores: number[]; version: string } | null> {
  const config = localConfiguration();
  if (!config || busy || signal?.aborted || !question.trim() || question.length > 1000 ||
      !passages.length || passages.length > maxPassages ||
      passages.some(({ text }) => !text.trim() || text.length > maxPassageLength)) return null;

  const body = JSON.stringify({
    model: config.version, query: question, documents: passages.map(({ text }) => text), top_n: passages.length,
  });
  const size = Buffer.byteLength(body);
  if (size > maxRequestBytes) return null;

  const deadline = AbortSignal.timeout(deadlineMs);
  busy = true;
  try {
    // Use a direct connection without the global HTTP agent or redirect handling.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request({
        hostname: "127.0.0.1",
        port: config.port,
        path: "/rerank",
        method: "POST",
        agent: false,
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
          "Content-Length": size,
        },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }, resolve);
      outgoing.once("error", reject);
      outgoing.end(body);
    });
    const contentType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (response.statusCode !== 200 || contentType !== "application/json") {
      response.destroy();
      return null;
    }

    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response as AsyncIterable<Buffer>) {
      length += chunk.byteLength;
      if (length > maxResponseBytes) return null;
      chunks.push(chunk);
    }

    const result = payload.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!result.success || result.data.results.length !== passages.length) return null;
    const scores = new Array<number>(passages.length);
    for (const { index, relevance_score } of result.data.results) {
      if (index >= passages.length || scores[index] !== undefined) return null;
      scores[index] = relevance_score;
    }
    return { scores, version: config.version };
  } catch {
    return null;
  } finally {
    busy = false;
  }
}
