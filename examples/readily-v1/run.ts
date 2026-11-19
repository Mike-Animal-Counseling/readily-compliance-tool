import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { createClient } from "./client.ts";

const { READILY_API_ORIGIN: origin, READILY_API_KEY: token } = process.env;
const [, , file, question] = process.argv;
if (!origin || !token || !file || !question) {
  throw new Error('Set READILY_API_ORIGIN and READILY_API_KEY, then run node run.ts policy.pdf "What does section 4.1 state?"');
}
const client = createClient(origin, token);
if ((await client.active()).id) throw new Error("Run the example on an empty test tenant");

const requestId = randomUUID();
const pdf = await readFile(file);
const uploaded = await client.upload(pdf, {
  documentKey: "example-policy", fileName: basename(file), effectiveFrom: "2020-01-01",
}, `${requestId}:upload`);
const document = await client.json<{ sha256: string }>(`/documents/${uploaded.id}`);
const snapshot = await client.index([uploaded.id], `${requestId}:index`);
await client.activate(snapshot.id, null, `${requestId}:activate`);
const report = await client.evaluate(question, `${requestId}:evaluate`);
const replay = await client.evaluate(question, `${requestId}:evaluate`);
if (replay.id !== report.id) throw new Error("Evaluation replay changed the report ID");

const citation = report.result.claims[0]?.evidence[0] ?? report.result.exceptions[0] ?? report.result.excerpts[0];
if (!citation) throw new Error("The question did not locate evidence in the supplied PDF");
const location = await client.locate(report.id, citation);
if (!location.unit.text.includes(citation.quote)) throw new Error("The returned location did not contain the quote");
const original = await client.request(location.source.replace(/^\/api\/v1/, ""));
const digest = createHash("sha256").update(Buffer.from(await original.arrayBuffer())).digest("hex");
if (digest !== document.sha256) throw new Error("The original PDF did not match the stored checksum");

const review = await client.review(report.id, {
  state: "needs_review",
  notes: "Example client verified the quote and original PDF checksum.",
  expectedRevision: null,
}, `${requestId}:review`);
const status = await client.report(report.id);
console.log(JSON.stringify({
  reportId: status.id, snapshotId: status.snapshotId, status: status.result.status,
  page: location.cell?.box.page ?? location.unit.boxes[0]?.page,
  reviewState: status.reviewState, reviewRevision: review.revision,
}, null, 2));
