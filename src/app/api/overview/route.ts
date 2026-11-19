import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { getOverview } from "@/gateway/service";

/** GET /api/overview — dashboard home: today's counts, pending approvals, recent activity, projects. */
export async function GET(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) => toResponse(await getOverview(principal)));
}
