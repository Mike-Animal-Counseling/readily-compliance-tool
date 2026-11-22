# Readily v1 release and recovery

The existing workspace uses its session-based upload and assessment endpoints. The third-party integration uses bearer keys at `/api/v1`, with `read`, `ingest`, `evaluate`, `review` and `index` permissions. Keys identify the tenant on the server. Resources, source downloads, report revisions and request replays are scoped by that identity.

## Evidence and limits

The layout worker retains numbered clauses, nested text, ruled table rows and cells, repeated headers on contiguous pages, page-relative coordinates and the original PDF checksum. The pdf2json worker has a 10-second deadline, a 128 MiB heap cap and two slots. Complex layouts go to review.

### Same-host OCR

The optional Docling worker adds English text, table rows and page locations for pages without a text layer. The app preserves its native extraction on other pages, stores the original PDF and records the combined parser version. OCR pages are marked for review. If the local worker is unavailable or produces invalid evidence, unreadable pages retain their review warning.

Prepare the model weights in a dedicated environment before accepting documents.

```sh
python -m pip install -r workers/ocr/requirements.txt
python workers/ocr/serve.py --prepare-models
```

Start `python workers/ocr/serve.py` under a supervisor with a 2 GiB memory limit and two CPU threads. Set the same `READILY_V1_OCR_PORT` and independent random `READILY_V1_OCR_TOKEN` in the app and worker. Keep both on the same host and reuse the prepared model cache. The worker binds to loopback, handles one document at a time and uses offline inference. The app waits at most 10 seconds for OCR within a combined 16-second parsing window. Representative scans still need private validation before rollout. [Docling document model](https://docling-project.github.io/docling/concepts/docling_document/)

### Retrieval and assessment

Search combines clause-number matches, PostgreSQL text ranking and cosine distance over local, versioned 128-dimensional embeddings using reciprocal rank fusion. It scores matching children within the bounded snapshot and selects up to five distinct parents by their highest child score. Each selected parent retains all its matching child positions. The reader processes each parent in order, carrying table headers across batches and following uniquely resolved clause references. General interpretations, unresolved references and potentially material conditions go to review. Direct unambiguous clause lookups can produce exact quotations. Automated v1 assessment uses local processing. The existing workspace's OpenRouter data flow is documented in the [workspace security guide](PRODUCTION_SECURITY.md).

#### Optional same-host reranking

For questions without explicit clause references, the app can group the hybrid hits into up to 20 distinct document-version and parent pairs and score each parent's highest-ranked child excerpt using a local cross-encoder. Each excerpt is capped at 1,200 characters. After scoring, the app selects up to five parents, reads each complete parent once and preserves all its child hits. Clause-number requests use reciprocal rank fusion. Reports record the retrieval method and, when used, the configured model version. Existing report payloads may omit this metadata.

Apply `003_rerank_passages.sql` before deploying this build. Build a new snapshot from the existing immutable document versions to populate excerpts. Earlier snapshots continue to serve through the reciprocal rank fusion path. Keep the previous snapshot available for rollback.

Use a supervised, resource-bounded llama.cpp server with a pinned reranker model file and alias. Bind to `127.0.0.1`, enable `--reranking`, `--offline` and `--no-webui`, disable prompt caching with `--no-cache-prompt --cache-ram 0` and configure a dedicated random `--api-key` through the deployment secret store. Disable request logging. Set `READILY_V1_RERANK_PORT`, `READILY_V1_RERANK_TOKEN` and `READILY_V1_RERANK_MODEL` on the same app host. Include the model revision in the alias for production. The app permits one in-flight rerank per process and falls back to reciprocal rank fusion on busy, timeout, malformed response or missing passages. The request deadline is 2.5 seconds. Leave the settings unset until private relevance and latency validation passes on the target hardware. [llama.cpp server options and rerank protocol](https://github.com/ggml-org/llama.cpp/blob/b12626/tools/server/README.md)

Use `POST /api/v1/reports/batch` for up to five questions in a single transaction. For longer questionnaires, pass the first batch's `snapshotId` and `asOf` with subsequent batches. Each report remains individually reviewable and source-addressable.

Uploads are limited to 2 MiB and 30 pages, with storage bounds on parsed layouts. Each tenant can store 100 document versions and 40 snapshots. Each snapshot can include up to 20 versions and 10,000 children. Request budgets use shared Redis in production. Per-tenant transaction locks separate upload, indexing, question evaluation and review. The service returns a retryable error when a lane is busy.

## Deployment

1. Run `npm ci --ignore-scripts`, `npm audit --audit-level=low`, `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`. The application workflow serves the built Next.js package with authenticated TLS Redis and certificate-verified PostgreSQL/pgvector. Run the release holdout in a private environment with approved representative PDFs before enabling production.
2. On the authorized PostgreSQL service, apply the forward-only migrations in `db/migrations` in lexical order using the migration role and `psql -X -v ON_ERROR_STOP=1 -f` for each file. Keep backups and recovery settings appropriate to the environment. Give the runtime role schema usage, read access to the v1 tables, and the following narrowly scoped write privileges. The migration role manages tenants and keys.

```sql
GRANT USAGE ON SCHEMA readily_v1 TO readily_api;
GRANT SELECT ON ALL TABLES IN SCHEMA readily_v1 TO readily_api;
GRANT INSERT ON readily_v1.document_versions, readily_v1.parents,
  readily_v1.clause_locations, readily_v1.snapshots, readily_v1.snapshot_documents,
  readily_v1.index_entries, readily_v1.activations, readily_v1.reports,
  readily_v1.reviews, readily_v1.requests TO readily_api;
GRANT UPDATE (active_snapshot_id) ON readily_v1.tenants TO readily_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA readily_v1 TO readily_api;
```

3. Configure the exact HTTPS origin and production session/Redis settings from the workspace guide. Set `READILY_V1_DATABASE_URL` in the deployment's secret store with the runtime credentials and `sslmode=verify-full` to verify the database certificate and host. Keep `READILY_V1_ENABLED` off while deploying and validating infrastructure.
4. Provision two enabled disposable test tenants with empty active snapshots and separate expiring keys. Give the primary key the `read`, `ingest`, `index`, `evaluate` and `review` scopes. Give the isolation key `read`, `index` and `review` for the foreign-resource checks. Generate each key with 32 random bytes encoded as base64url and prefixed by `rdy_`. Store plaintext keys in the secret manager and insert only their hexadecimal SHA-256 digests into `readily_v1.api_keys.digest`, along with the tenant ID, reviewer label, scopes and expiry.
5. Enable `READILY_V1_ENABLED=true` in the authorized canary and redeploy. Set `READILY_API_ORIGIN` to the exact deployment origin. Load the two keys into `READILY_V1_CANARY_PRIMARY_KEY` and `READILY_V1_CANARY_ISOLATION_KEY`, then run `npm run test:evidence:canary`. The script uploads synthetic policies, verifies full parents, review history, source checksums, idempotent replays and foreign-tenant 404s, then cuts over and rolls back the test snapshot using compare-and-set. The original reports remain pinned across both changes. Record the deployment ID and the two snapshot IDs printed by the script, then purge the disposable tenants.
6. Run the [standalone example](../examples/readily-v1/README.md) with a fresh empty test tenant. On the production workspace also verify login and upload, evaluate a synthetic questionnaire, record a review and export CSV. Use the [OpenAPI contract](openapi.v1.yaml) for the production tenant rollout.

## Benchmark

The CI benchmark uses 24 development questions and a separate 24-question synthetic holdout with disjoint gold clauses. Coverage measures whether each labeled quote is present in the complete gold parent. Recall@5 measures whether the retrieved parents include that gold parent, compared with the legacy top-five chunks containing the gold text. Citation accuracy requires the gold parent and an exact round trip to the source unit. Exception coverage checks that the required condition is included and sent to review. Conditional coverage measures this after a parent hit. The output also reports the share of questions answered automatically with the gold quote, measured assessment p95, and third-party provider cost. Quantitative release targets and representative-sample approval remain in the roadmap.

CI also runs a harder labeled synthetic PDF through the default ranking path. Run `npm run test:evidence:rerank` with `READILY_V1_TEST_DATABASE_URL` pointing to a disposable loopback `readily_v1_test` database and the optional local reranker settings above. The script compares reciprocal rank fusion and cross-encoder ranking, checks gold-parent candidate coverage, and verifies report citations against their source geometry. It reports development and holdout results separately. Set `READILY_V1_RERANK_BENCHMARK_TIMEOUT_MS` only for offline comparisons on slower hardware. The deployed deadline is fixed.

## Rollback

1. For a bad policy/index, call `POST /api/v1/snapshots/{previousSnapshotId}/activate` with a new idempotency key and `{"expectedActiveSnapshotId":"<currentSnapshotId>"}`. Check `GET /api/v1/snapshots/active`, submit a fresh assessment and resolve original citations from reports created on both versions.
2. For a tenant-specific incident, disable the affected tenant or revoke the affected keys in the control database. Requests fail at authentication. For a platform incident, disable v1 and redeploy or use Vercel Instant Rollback to the prior verified production deployment. Verify the production alias and rerun the applicable smoke tests. [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)
3. Retain the database data and migrations during an application rollback. Historical reports depend on old snapshot membership, parsed parents and original PDF bytes. Rebuild a damaged inactive index from the immutable policy versions and validate it before activation.
4. To roll back reranking, unset the three `READILY_V1_RERANK_*` app settings and restart the app. New reports use reciprocal rank fusion. Previously stored reports keep their original evidence and retrieval metadata.

## Retention and deletion

Set each tenant's retention term and backup expiry before onboarding. The v1 database stores originals, parsed coordinates, search entries, reports, review changes and request receipts. To remove a tenant, disable access, confirm the tenant ID and retention obligations, and delete that tenant row with the migration role in one transaction. Foreign keys cascade through those records. Verify that tenant-scoped originals, reports and receipts are gone. The rate-limit cache stores hashed counter keys that expire automatically. Backups follow the database retention and deletion schedule.
