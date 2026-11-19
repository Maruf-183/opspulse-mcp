import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { listRequests } from "@/gateway/service";

/** GET /api/approvals — requests waiting for a human (alias of /api/requests?status=pending). */
export async function GET(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) => toResponse(await listRequests(principal, "pending")));
}
