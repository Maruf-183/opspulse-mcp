import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { getRecentAuditLogs } from "@/services/ticket.service";

/** GET /api/audit-logs?limit=25 */
export async function GET(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) => {
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 25);
    return toResponse(await getRecentAuditLogs(principal, Number.isFinite(limit) ? limit : 25));
  });
}
