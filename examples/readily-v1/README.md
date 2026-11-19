# Standalone Readily client

Copy `client.ts` and `run.ts` into a separate folder. Use Node.js 24 or later. Set `READILY_API_ORIGIN` to the deployment origin and load `READILY_API_KEY` from your secret store. The example needs an empty test tenant and a key with `read`, `ingest`, `index`, `evaluate` and `review` scopes.

```sh
node run.ts ./synthetic-policy.pdf "What does section 4.1 state?"
```

Use a text-layer PDF with a numbered section matching the question. The client uploads the file, checks document status, builds and activates an index, evaluates and replays the question, resolves a citation, verifies the original file's SHA-256, and records a review. The result includes the report ID, snapshot ID, cited page and review revision. For questionnaires, call `evaluate` for each question with a persistent request key.

Persist the same idempotency key and normalized input when retrying a write across process restarts. A fresh run of the example needs a fresh test tenant because the sample activates a snapshot. See the [OpenAPI contract](../../docs/openapi.v1.yaml) and [release runbook](../../docs/READILY_V1_RELEASE.md).
