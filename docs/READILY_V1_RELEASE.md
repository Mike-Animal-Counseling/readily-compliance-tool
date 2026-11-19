# Readily v1 release and recovery

The existing workspace uses its session-based upload and assessment endpoints. The third-party integration uses bearer keys at `/api/v1`, with `read`, `ingest`, `evaluate`, `review` and `index` permissions. Keys identify the tenant on the server. Resources, source downloads, report revisions and request replays are scoped by that identity.

## Evidence and limits

The layout worker retains numbered clauses, nested text, ruled table rows and cells, repeated headers on contiguous pages, page-relative coordinates and the original PDF checksum. Complex page layouts and pages without text go to review. The worker uses pdf2json with the existing 10-second, 128 MiB and two-worker limits. Docling's document model supports reading order, table structure and provenance. A separate Docling/OCR worker still needs runtime and corpus validation. [Docling document model](https://docling-project.github.io/docling/concepts/docling_document/)

Search combines clause-number matches, PostgreSQL text ranking and cosine distance over local, versioned 128-dimensional embeddings using reciprocal rank fusion. The index retains bounded candidates from each signal. The highest child score determines the rank of each distinct parent. A report preserves the child hit positions and links to the full parent. The reader processes each parent in order, carrying table headers across batches and following uniquely resolved clause references. General interpretations, unresolved references and potentially material conditions go to review. Direct unambiguous clause lookups can produce exact quotations. Automated v1 assessment uses local processing. The existing workspace's OpenRouter data flow is documented in the [workspace security guide](PRODUCTION_SECURITY.md).

Uploads are limited to 2 MiB and 30 pages, with storage bounds on parsed layouts. Each tenant can store 100 document versions and 40 snapshots. Each snapshot can include up to 20 versions and 10,000 children. Request budgets use shared Redis in production. Per-tenant transaction locks separate upload, indexing, question evaluation and review. The service returns a retryable error when a lane is busy.

## Deployment

1. Run `npm ci --ignore-scripts`, `npm audit --audit-level=low`, `npm test`, `npm run lint`, `npm run typecheck` and `npm run build`. Run the application workflow's HTTP checks with a dedicated PostgreSQL/pgvector service. Run the release holdout in a private environment with approved representative PDFs before enabling production.
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

3. Configure the exact HTTPS origin and production session/Redis settings from the workspace guide. Set `READILY_V1_DATABASE_URL` in the deployment's secret store with a TLS connection and the runtime credentials. Keep `READILY_V1_ENABLED` off while deploying and validating infrastructure.
4. Provision one enabled test tenant and an expiring key. Generate the key with 32 random bytes encoded as base64url and prefixed by `rdy_`. Store the plaintext in the secret manager. Insert only the hexadecimal SHA-256 of that exact string into `readily_v1.api_keys.digest`, along with the tenant ID, reviewer label, scopes and expiry.
5. Enable `READILY_V1_ENABLED=true` in the authorized canary and redeploy. Use the [standalone example](../examples/readily-v1/README.md) against the live URL with a synthetic policy. Verify the stored checksum and citation coordinates, an idempotent replay, a foreign-tenant 404, review history and the existing workspace flow. Keep the deployment ID and active snapshot ID from before the change.
6. Build the replacement snapshot while the previous snapshot serves traffic. Activate it using the compare-and-set request in the [OpenAPI contract](openapi.v1.yaml). Verify the new report uses the new snapshot, the old report still resolves to its original PDF and an out-of-period version is excluded.

## Benchmark

The CI benchmark uses 24 development questions and a separate 24-question synthetic holdout with disjoint gold clauses. Coverage measures whether each labeled quote is present in the complete gold parent. Recall@5 measures whether the retrieved parents include that gold parent, compared with the legacy top-five chunks containing the gold text. Citation accuracy requires the gold parent and an exact round trip to the source unit. Exception coverage checks that the required condition is included and sent to review. Conditional coverage measures this after a parent hit. The output also reports the share of questions answered automatically with the gold quote, measured assessment p95, and third-party provider cost. Quantitative release targets and representative-sample approval remain in the roadmap.

## Rollback

1. For a bad policy/index, call `POST /api/v1/snapshots/{previousSnapshotId}/activate` with a new idempotency key and `{"expectedActiveSnapshotId":"<currentSnapshotId>"}`. Check `GET /api/v1/snapshots/active`, submit a fresh assessment and resolve original citations from reports created on both versions.
2. For a tenant-specific incident, disable the affected tenant or revoke the affected keys in the control database. Requests fail at authentication. For a platform incident, disable v1 and redeploy or use Vercel Instant Rollback to the prior verified production deployment. Verify the production alias and rerun the applicable smoke tests. [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)
3. Retain the database data and migrations during an application rollback. Historical reports depend on old snapshot membership, parsed parents and original PDF bytes. Rebuild a damaged inactive index from the immutable policy versions and validate it before activation.

## Retention and deletion

Set each tenant's retention term and backup expiry before onboarding. The v1 database stores originals, parsed coordinates, search entries, reports, review changes and request receipts. To remove a tenant, disable access, confirm the tenant ID and retention obligations, and delete that tenant row with the migration role in one transaction. Foreign keys cascade through those records. Verify that tenant-scoped originals, reports and receipts are gone. The rate-limit cache stores hashed counter keys that expire automatically. Backups follow the database retention and deletion schedule.
