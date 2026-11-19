import { NextRequest } from "next/server";
import { errorResponse, readJson, toResponse, withBrowserPrincipal } from "@/lib/http";
import { approveRequest, rejectRequest } from "@/gateway/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/approvals/:id  { approve: boolean }
 *
 * Kept for the demo page; delegates to the gateway (`/api/requests/:id/approve|reject`).
 * Requires `request:decide`, which only human principals can hold.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return errorResponse("VALIDATION_FAILED", "Invalid approval ID.");

  return withBrowserPrincipal(req, async (principal) => {
    const body = await readJson(req);
    const approve = typeof body === "object" && body !== null && "approve" in body ? body.approve : undefined;
    if (typeof approve !== "boolean") {
      return errorResponse("VALIDATION_FAILED", 'Body must be { "approve": true | false }.');
    }
    return toResponse(await (approve ? approveRequest(principal, id) : rejectRequest(principal, id)));
  });
}
