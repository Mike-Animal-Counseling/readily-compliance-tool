import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ApiError } from "../examples/readily-v1/client";
import type { createClient } from "../examples/readily-v1/client";
import type { ParentBlock } from "../lib/evidence/model";
import { pdfGrid, pdfLines, synthPdf } from "../tests/fixtures/policy-pdf";

type Client = ReturnType<typeof createClient>;
export const policyFixtureMetadata = { documentKey: "dispatch", fileName: "synthetic.pdf", effectiveFrom: "2020-01-01" };
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export const expectedError = (status: number, code?: string) => (error: unknown) =>
  error instanceof ApiError && error.status === status && (!code || code === error.code);

export function versionPdf(marker: string) {
  const rows = Array.from({ length: 20 }, (_, index) =>
    `Control ${index + 1}: retain the manifest and review the documented checkpoint with the lead.`);
  return synthPdf([
    pdfLines(["Section 4.1 Dispatch", `Dispatch inventory uses ${marker} tags.`, ...rows]),
    pdfLines(["Section 4.1 Dispatch", ...rows]),
    pdfLines(["Section 4.1 Dispatch", ...rows, "Unless waived under section 99.7, retain the final entry."]),
    pdfLines(["Section 7.1 Inventory", "Reconcile stock counts."]) + "\n" + pdfGrid([["Item", "Quantity"], ["Seal", "Twelve"]], 655),
  ]);
}

export async function verifyEvidenceCanary(
  client: Client,
  other: Client,
  checkInactiveIndex?: (pendingVersionId: string, activeSnapshotId: string) => Promise<void>,
) {
  const [primary, isolation] = await Promise.all([client.active(), other.active()]);
  assert.equal(primary.id, null, "The canary requires an empty primary test tenant");
  assert.equal(isolation.id, null, "The canary requires an empty isolation test tenant");
  const original = versionPdf("indigo");
  const metadata = policyFixtureMetadata;
  const first = await client.upload(original, metadata, "upload");
  assert.equal((await client.upload(original, metadata, "upload")).id, first.id);
  await assert.rejects(client.upload(original, { ...metadata, documentKey: "different" }, "upload"),
    expectedError(409, "idempotency_conflict"));
  await assert.rejects(other.request(`/documents/${first.id}/source`), expectedError(404));
  await assert.rejects(other.index([first.id], "index"), expectedError(404));

  const a = await client.index([first.id], "build-a");
  await client.activate(a.id, null, "activate-a");
  await assert.rejects(other.activate(a.id, null, "foreign-activate"), expectedError(404));
  const question = "What does section 4.1 state?";
  const questions = [question, "Show section 7.1"];
  const questionnaire = await client.evaluateBatch(questions, "questionnaire");
  assert.equal(questionnaire.snapshotId, a.id);
  assert.deepEqual(questionnaire.reports.map(report => report.result.question), questions);
  assert.ok(questionnaire.reports.every(report => report.snapshotId === questionnaire.snapshotId && report.asOf === questionnaire.asOf));
  const [old, replay] = await Promise.all([
    client.evaluate(question, "parallel-eval", "2024-01-01"),
    client.evaluate(question, "parallel-eval", "2024-01-01"),
  ]);
  assert.equal(replay.id, old.id);
  const matches = old.result.parents.filter(parent => parent.parentId === "p1");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].hits.length, 3);
  assert.equal(new Set(matches[0].hits.flatMap(hit => hit.unitIds)).size, matches[0].hits.flatMap(hit => hit.unitIds).length);
  assert.equal(old.result.status, "needs_review");
  assert.ok(old.result.batchesRead > 1);
  assert.ok(old.result.reasons.includes("unresolved_clause_reference"));
  const firstEvidence = old.result.excerpts.find(item => item.quote.includes("indigo"));
  assert.ok(firstEvidence);
  const evidencePath = `/reports/${old.id}/evidence/${first.id}/p1`;
  const initialLocation = await client.locate(old.id, firstEvidence);
  assert.equal(initialLocation.unit.boxes[0].page, 1);
  const complete = await client.json<{ block: ParentBlock }>(evidencePath);
  assert.ok(complete.block.units.at(-1)?.text.includes("99.7"));
  assert.ok(complete.block.units.some(item => item.boxes.some(box => box.page === 3)));
  assert.equal(old.result.exceptions.length, 1);
  assert.ok(old.result.exceptions[0].quote.includes("retain the final entry"));
  await assert.rejects(other.report(old.id), expectedError(404));
  await assert.rejects(other.request(evidencePath), expectedError(404));
  await assert.rejects(other.review(old.id, { state: "approved", notes: "invalid tenant", expectedRevision: null }, "foreign-review"),
    expectedError(404));

  const reviewInput = { state: "approved", notes: "Synthetic reviewer checked the exception manually.",
    expectedRevision: null, answerOverride: "Synthetic approved answer." } as const;
  const review = await client.review(old.id, reviewInput, "review");
  assert.equal((await client.review(old.id, reviewInput, "review")).revision, review.revision);
  await assert.rejects(client.review(old.id, reviewInput, "stale-review"), expectedError(409, "review_revision_changed"));
  assert.equal((await client.report(old.id)).reviewState, "approved");
  const history = await client.json<{ items: { answerOverride: string }[] }>(`/reports/${old.id}/reviews`);
  assert.equal(history.items[0].answerOverride, reviewInput.answerOverride);

  const second = await client.upload(versionPdf("amber"), { ...metadata, effectiveFrom: "2023-01-01" }, "upload-b");
  const [b, duringBuild] = await Promise.all([
    client.index([second.id], "build-b"),
    client.evaluate(question, "during-build", "2024-01-01"),
  ]);
  assert.equal(duringBuild.snapshotId, a.id);
  assert.equal((await client.active()).id, a.id);
  await assert.rejects(client.evaluateBatch(questions, "unactivated-questionnaire", { snapshotId: b.id }),
    expectedError(404, "usable_snapshot_not_found"));
  await checkInactiveIndex?.(second.id, a.id);
  console.log(JSON.stringify({ previousSnapshotId: a.id, candidateSnapshotId: b.id }));
  let newer: Awaited<ReturnType<Client["evaluate"]>>;
  try {
    await client.activate(b.id, a.id, "activate-b");
    await assert.rejects(client.activate(a.id, a.id, "bad-cas"), expectedError(409, "active_snapshot_changed"));
    newer = await client.evaluate(question, "new-eval", "2024-01-01");
    assert.equal(newer.snapshotId, b.id);
    const replayed = await client.evaluateBatch(questions, "questionnaire");
    assert.deepEqual(replayed, questionnaire);
    const continued = await client.evaluateBatch([questions[1]], "next-questionnaire-batch", {
      snapshotId: questionnaire.snapshotId, asOf: questionnaire.asOf,
    });
    assert.equal(continued.reports[0].snapshotId, a.id);
    assert.equal(continued.reports[0].asOf, questionnaire.asOf);
    assert.equal((await client.report(continued.reports[0].id)).snapshotId, a.id);
    assert.ok(newer.result.excerpts.some(item => item.documentVersionId === second.id && item.quote.includes("amber")));
    const beforeEffective = await client.evaluate(question, "before-effective", "2020-06-01");
    assert.equal(beforeEffective.result.status, "insufficient");
    assert.deepEqual(await client.json(evidencePath), complete);
    assert.equal(sha(Buffer.from(await (await client.request(`/documents/${first.id}/source`)).arrayBuffer())), sha(original));
  } finally {
    // A failed activation request might still have committed. Restore only our own snapshot.
    if ((await client.active()).id === b.id) await client.activate(a.id, b.id, "rollback");
  }
  assert.equal((await client.active()).id, a.id);
  const recovered = await client.evaluate(question, "rollback-eval", "2024-01-01");
  assert.equal(recovered.snapshotId, a.id);
  assert.equal((await client.report(newer.id)).snapshotId, b.id);
  assert.equal((await client.report(old.id)).snapshotId, a.id);
  console.log("HTTP parent deduplication, tenant isolation, idempotency, historical PDF and snapshot recovery passed");
}
