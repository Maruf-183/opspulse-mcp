import { NextRequest } from "next/server";
import { errorResponse, toResponse, withBrowserPrincipal } from "@/lib/http";
import { listRequests } from "@/gateway/service";
import { REQUEST_STATUSES, type RequestStatus } from "@/gateway/types";

/** GET /api/requests?status=pending&limit=50 */
export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  if (status && !REQUEST_STATUSES.includes(status as RequestStatus)) {
    return errorResponse("VALIDATION_FAILED", `status must be one of: ${REQUEST_STATUSES.join(", ")}`);
  }
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  return withBrowserPrincipal(req, async (principal) =>
    toResponse(await listRequests(principal, (status ?? undefined) as RequestStatus | undefined, Number.isFinite(limit) ? limit : 50)),
  );
}
