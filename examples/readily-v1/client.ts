export type Citation = {
  documentVersionId: string; parentId: string; unitId: string; quote: string; column?: number;
};
export type ParentMatch = {
  documentVersionId: string; parentId: string; hits: { childId: string; unitIds: string[] }[];
};
export type Report = {
  id: string;
  snapshotId: string;
  status: "completed";
  asOf: string;
  reviewState?: "pending" | "approved" | "needs_review";
  reviewRevision?: string | null;
  result: {
    status: "supported" | "insufficient" | "needs_review";
    reasons: string[];
    parents: ParentMatch[];
    claims: { statement: string; evidence: Citation[] }[];
    excerpts: Citation[];
    exceptions: Citation[];
    batchesRead: number;
  };
};
export type Box = { page: number; left: number; top: number; right: number; bottom: number };
export type LocatedUnit = {
  source: string;
  unit: { id: string; text: string; boxes: Box[] };
  cell?: { column: number; text: string; box: Box };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Readily API returned ${status} (${code})`);
    this.status = status;
    this.code = code;
  }
}

export function createClient(endpoint: string, token: string) {
  const origin = new URL(endpoint);
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(localhost && origin.protocol === "http:")) ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Use a Readily HTTPS origin");
  }

  async function request(path: string, method: "GET" | "POST" = "GET", body?: object | Uint8Array, idempotencyKey?: string) {
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const url = new URL(`/api/v1${path}`, origin);
    if (!url.pathname.startsWith("/api/v1/")) throw new Error("Use a Readily v1 route");
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    if (body) headers.set("Content-Type", body instanceof Uint8Array ? "application/pdf" : "application/json");
    const payload = body instanceof Uint8Array ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { method, body: payload, headers, redirect: "error", signal: AbortSignal.timeout(45000) });
      } catch (error) {
        if (attempt === 2 || (method !== "GET" && !idempotencyKey)) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      if (response.ok) return response;
      const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      if (attempt === 2 || ![429, 503].includes(response.status) || (method !== "GET" && !idempotencyKey)) {
        throw new ApiError(response.status, error?.error?.code ?? "request_failed");
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise(resolve => setTimeout(resolve, Math.min(retryAfter > 0 ? retryAfter : 1, 5) * 1000));
    }
    throw new Error("Readily API retry limit reached");
  }

  async function json<T>(path: string, method: "GET" | "POST" = "GET", body?: object | Uint8Array, key?: string) {
    return await (await request(path, method, body, key)).json() as T;
  }

  return {
    request,
    json,
    upload(pdf: Uint8Array, metadata: { documentKey: string; fileName: string; effectiveFrom: string; effectiveUntil?: string }, key: string) {
      return json<{ id: string; status: "ready" | "needs_review" }>(`/documents?${new URLSearchParams(metadata)}`, "POST", pdf, key);
    },
    index(documentVersionIds: string[], key: string) {
      return json<{ id: string; entryCount: number }>("/snapshots", "POST", { documentVersionIds }, key);
    },
    activate(snapshot: string, expectedActiveSnapshotId: string | null, key: string) {
      return json<{ id: string }>(`/snapshots/${snapshot}/activate`, "POST", { expectedActiveSnapshotId }, key);
    },
    active() {
      return json<{ id: string | null }>("/snapshots/active");
    },
    evaluate(question: string, key: string, asOf?: string) {
      return json<Report>("/reports", "POST", { question, asOf }, key);
    },
    report(id: string) {
      return json<Report>(`/reports/${id}`);
    },
    locate(id: string, citation: Citation) {
      const { documentVersionId, parentId, unitId, column } = citation;
      return json<LocatedUnit>(`/reports/${id}/evidence/${documentVersionId}/${parentId}/${unitId}${column ? `?column=${column}` : ""}`);
    },
    review(id: string, input: { state: "approved" | "needs_review"; notes: string; expectedRevision: string | null; answerOverride?: string }, key: string) {
      return json<{ revision: string }>(`/reports/${id}/reviews`, "POST", input, key);
    },
  };
}
