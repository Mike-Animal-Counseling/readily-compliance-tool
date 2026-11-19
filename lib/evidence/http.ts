import { createHash } from "node:crypto";
import { takeBudget } from "../security/store";
import { evidenceDb } from "./connection";
import { EvidenceError } from "./repository";
import type { Transaction } from "./repository";

type Scope = "read" | "ingest" | "evaluate" | "review" | "index";
export type Principal = { tenant: string; label: string };
const maxPdf = 2 * 1024 * 1024;

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function problem(status: number, code: string) {
  return Response.json({ error: { code } }, {
    status,
    headers: status === 401 ? { "WWW-Authenticate": "Bearer" } : status === 429 ? { "Retry-After": "2" } : {},
  });
}

export function guardV1(scope: Scope, handler: (request: Request, principal: Principal) => Promise<Response>) {
  return async (request: Request) => {
    let response: Response;
    try {
      if (process.env.READILY_V1_ENABLED !== "true") throw new EvidenceError(404, "api_unavailable");
      const token = request.headers.get("authorization")?.match(/^Bearer (rdy_[A-Za-z0-9_-]{43})$/i)?.[1];
      if (!token) throw new EvidenceError(401, "authentication_required");
      if (!await takeBudget("v1:auth", 1500, 60)) throw new EvidenceError(429, "request_limit");
      const sql = evidenceDb();
      const [key] = await sql<{ tenant: string; label: string; scopes: Scope[] }[]>`
        select k.tenant_id as tenant, k.label, k.scopes
        from readily_v1.api_keys k join readily_v1.tenants t on t.id = k.tenant_id
        where k.digest = ${sha256(token)} and t.enabled and k.revoked_at is null and k.expires_at > now()
      `;
      if (!key) throw new EvidenceError(401, "authentication_required");
      if (!key.scopes.includes(scope)) throw new EvidenceError(403, "scope_required");
      if (!await takeBudget("v1:tenant:" + key.tenant, 180, 60) ||
          (request.method !== "GET" && !await takeBudget("v1:writes:" + key.tenant, 300, 86400))) {
        throw new EvidenceError(429, "request_limit");
      }
      response = await handler(request, key);
    } catch (error) {
      response = error instanceof EvidenceError
        ? problem(error.status, error.code)
        : problem(503, "service_unavailable");
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  };
}

export async function bodyBytes(request: Request, contentType: "application/pdf" | "application/json") {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType) {
    throw new EvidenceError(415, "unsupported_content_type");
  }
  const max = contentType === "application/pdf" ? maxPdf : 32 * 1024;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > max) {
          await reader.cancel();
          throw new EvidenceError(413, "body_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(chunks);
}

export async function readJson(request: Request): Promise<unknown> {
  const bytes = await bodyBytes(request, "application/json");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new EvidenceError(400, "invalid_json");
  }
}

export async function idempotent(
  request: Request, tenant: string, operation: string, lane: string, input: unknown,
  perform: (sql: Transaction) => Promise<postgresJson>, status = 201,
) {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new EvidenceError(400, "idempotency_key_required");
  const fingerprint = sha256(JSON.stringify(input));
  const result = await evidenceDb().begin(async sql => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`request:${tenant}:${operation}:${key}`}, 0))`;
    const [old] = await sql<{ fingerprint: string; response: postgresJson }[]>`
      select fingerprint, response from readily_v1.requests
      where tenant_id = ${tenant} and operation = ${operation} and request_key = ${key}
    `;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new EvidenceError(409, "idempotency_conflict");
      return { body: old.response, replayed: true };
    }
    const [{ locked }] = await sql`select pg_try_advisory_xact_lock(hashtextextended(${`lane:${tenant}:${lane}`}, 0)) as locked`;
    if (!locked) throw new EvidenceError(429, "operation_busy");
    const body = await perform(sql);
    await sql`insert into readily_v1.requests (tenant_id, operation, request_key, fingerprint, response)
      values (${tenant}, ${operation}, ${key}, ${fingerprint}, ${sql.json(body)})`;
    return { body, replayed: false };
  });
  return Response.json(result.body, {
    status,
    headers: { "Idempotency-Replayed": String(result.replayed) },
  });
}

type postgresJson = import("postgres").JSONValue;
