# Standalone Readily client

Copy the three TypeScript files into a separate folder. Use Node.js 24 or later. Set `READILY_API_ORIGIN` to the deployment origin and load `READILY_API_KEY` from your secret store. The example needs an empty test tenant and a key with `read`, `ingest`, `index`, `evaluate` and `review` scopes.

```sh
node run.ts
```

The example builds a synthetic PDF in memory and sends it to the configured Readily origin over HTTPS, with plain HTTP available for loopback testing. It checks document status, builds and activates an index, evaluates and replays a question, resolves a citation, verifies the original file's SHA-256, and records a review. The result includes the report ID, snapshot ID, cited page and review revision. In your integration, pass approved policy bytes to `client.upload`. Use `client.evaluateBatch(questions, key)` for up to five questions at a time. For longer questionnaires, reuse the first batch's `snapshotId` and `asOf` in the third argument, with a distinct idempotency key for each batch.

Persist the same idempotency key and normalized input when retrying a write across process restarts. A fresh run of the example needs a fresh test tenant because the sample activates a snapshot. See the [OpenAPI contract](../../docs/openapi.v1.yaml) and [release runbook](../../docs/READILY_V1_RELEASE.md).
