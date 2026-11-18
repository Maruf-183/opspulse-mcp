import { NextRequest } from "next/server";
import { errorResponse, parseId, readJson, toResponse, withBrowserPrincipal } from "@/lib/http";
import { resolveDeletionRequest } from "@/services/ticket.service";

/**
 * POST /api/approvals/:id  { approve: boolean }
 *
 * Requires `ticket:delete:approve`, which only human principals can hold.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const approvalId = parseId((await params).id);
  if (!approvalId) return errorResponse("VALIDATION_FAILED", "Approval ID must be a positive integer.");

  return withBrowserPrincipal(req, async (principal) => {
    const body = await readJson(req);
    const approve =
      typeof body === "object" && body !== null && "approve" in body ? body.approve : undefined;
    if (typeof approve !== "boolean") {
      return errorResponse("VALIDATION_FAILED", 'Body must be { "approve": true | false }.');
    }
    return toResponse(await resolveDeletionRequest(principal, approvalId, approve));
  });
}
