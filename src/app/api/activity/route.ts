import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { listActivity } from "@/gateway/service";

/** GET /api/activity?limit=50 — hash-chained activity feed. */
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  return withBrowserPrincipal(req, async (principal) =>
    toResponse(await listActivity(principal, Number.isFinite(limit) ? limit : 50)),
  );
}
