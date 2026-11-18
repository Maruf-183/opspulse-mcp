import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { listPendingApprovals } from "@/services/ticket.service";

/** GET /api/approvals — pending deletion requests in this workspace. */
export async function GET(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) => toResponse(await listPendingApprovals(principal)));
}
