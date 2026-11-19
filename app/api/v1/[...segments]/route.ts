import { guardV1, problem } from "@/lib/evidence/http";
import * as api from "@/lib/evidence/operations";

export const runtime = "nodejs";
export const maxDuration = 40;

type Context = { params: Promise<{ segments: string[] }> };

export async function GET(request: Request, context: Context) {
  const { segments } = await context.params;
  const [collection, id, task, version, parent, unit] = segments;
  return guardV1("read", async (_, { tenant }) => {
    if (collection === "documents" && (segments.length === 2 || (segments.length === 3 && task === "source"))) {
      return api.documentVersion(tenant, id, task === "source");
    }
    if (collection === "snapshots" && segments.length === 2) return api.snapshotStatus(tenant, id);
    if (collection === "reports" && segments.length === 2) return api.reportStatus(tenant, id);
    if (collection === "reports" && task === "reviews" && segments.length === 3) {
      return api.reviews(tenant, id, new URL(request.url).searchParams.get("before") ?? undefined);
    }
    if (collection === "reports" && task === "evidence" && (segments.length === 5 || segments.length === 6)) {
      return api.locateEvidence(tenant, id, version, parent, unit, new URL(request.url).searchParams.get("column") ?? undefined);
    }
    return problem(404, "route_not_found");
  })(request);
}

export async function POST(request: Request, context: Context) {
  const { segments } = await context.params;
  const [collection, id, task] = segments;
  if (segments.length === 1) {
    if (collection === "documents") return guardV1("ingest", api.upload)(request);
    if (collection === "snapshots") return guardV1("index", api.indexSnapshot)(request);
    if (collection === "reports") return guardV1("evaluate", api.evaluate)(request);
  }
  if (segments.length === 3 && collection === "snapshots" && task === "activate") {
    return guardV1("index", (req, principal) => api.activate(req, principal, id))(request);
  }
  if (segments.length === 3 && collection === "reports" && task === "reviews") {
    return guardV1("review", (req, principal) => api.review(req, principal, id))(request);
  }
  return guardV1("read", async () => problem(404, "route_not_found"))(request);
}
