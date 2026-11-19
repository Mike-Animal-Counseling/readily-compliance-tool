# Readily production roadmap

[中文](PLAN.zh-CN.md)

A third-party application should be able to upload policies, evaluate a questionnaire and review the answers through a versioned API. Each material claim should point to the policy version, page, passage or table cell that supports it. The current Next.js workspace remains the reference application.

## Delivery sequence

1. **Parse and version documents.** Freeze the current parser and retrieval baseline. Evaluate Docling in a resource-limited worker using scans, multi-page tables, nested clauses and exceptions. Preserve headings, headers, row and column coordinates, page numbers and source spans. Version the document, parser, embeddings and index. Pin each evaluation to a snapshot, and activate new indexes atomically after validation.
2. **Retrieve children and read complete parents.** Index children, initially around 300–600 tokens, and retain their source spans. Within the tenant, group candidates by document-version ID and parent ID before selecting the top distinct parents. Read and return each parent once, retain all matched child locations, and initially rank by the best child. If necessary, draw more candidates from a bounded pool. Keep different versions separate. Read an oversized parent in clause- or table-aligned batches with source coordinates preserved, resolve explicit references, and reuse parents that were already read. Send unresolved exceptions or references for review.
3. **Hybrid retrieval and grounded output.** Use one versioned server-side embedding pipeline. Filter by tenant, snapshot and effective period. Combine exact clause matching, Postgres full-text ranking and pgvector with reciprocal rank fusion. Evaluate reranking and cross-policy decomposition separately. Validate claim-to-evidence links server-side. Keep evidence status and human review status separate.
4. **Integration.** Publish OpenAPI and a standalone TypeScript example for upload, job progress, evaluation, source lookup and review. Derive tenant scope from server credentials and enforce it on jobs, downloads, snapshots and caches. Cover idempotency, rate and upload limits, deletion of derived data and provider disclosures.

## Release acceptance

- Three child hits from one parent yield one complete parent and three traceable locations. Exercise long parents, multi-page tables, exceptions and versions. Existing reports keep their original snapshot after a policy update.
- Start with 20–30 baseline questions, then use an independent holdout. Proposed thresholds are 90% evidence coverage and 95% citation accuracy. Treat relative improvements of 20% in Recall@5 and 15% in evidence-supported claims as candidates to validate against a frozen baseline. Measure clause recall, coverage after retrieval, latency and cost separately.
- Pass the current workspace regression, a third-party client end-to-end test, and tenant isolation checks. Build the new index in parallel and rehearse tenant-level rollback and restore. Use public or synthetic fixtures for public tests.

Start with parser comparison, parent deduplication and the versioned evidence contract.

[Docling document model](https://docling-project.github.io/docling/concepts/docling_document/) · [Postgres text ranking](https://www.postgresql.org/docs/current/textsearch-controls.html#TEXTSEARCH-RANKING) · [pgvector](https://github.com/pgvector/pgvector)
