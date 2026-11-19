import { NextRequest } from "next/server";
import { errorResponse, parseId, readJson, toResponse, withBrowserPrincipal } from "@/lib/http";
import { getTicket, updateTicket } from "@/services/ticket.service";
import { invokeAction } from "@/gateway/service";
import { BUILTIN_TICKETS_ID } from "@/gateway/builtin/tickets";

type Context = { params: Promise<{ id: string }> };

const invalidId = () => errorResponse("VALIDATION_FAILED", "Ticket ID must be a positive integer.");

/** GET /api/tickets/:id */
export async function GET(req: NextRequest, { params }: Context) {
  const id = parseId((await params).id);
  if (!id) return invalidId();
  return withBrowserPrincipal(req, async (principal) => toResponse(await getTicket(principal, id)));
}

/** PATCH /api/tickets/:id  { status?, priority? } */
export async function PATCH(req: NextRequest, { params }: Context) {
  const id = parseId((await params).id);
  if (!id) return invalidId();
  return withBrowserPrincipal(req, async (principal) =>
    toResponse(await updateTicket(principal, id, await readJson(req))),
  );
}

/**
 * DELETE /api/tickets/:id  { reason? }
 *
 * Goes through the gateway like any AI action, so the workspace's rule for
 * "Delete a ticket" applies (by default "Ask me first" → 202 with a pending
 * request to approve at POST /api/requests/:id/approve).
 */
export async function DELETE(req: NextRequest, { params }: Context) {
  const id = parseId((await params).id);
  if (!id) return invalidId();
  return withBrowserPrincipal(req, async (principal) => {
    const body = await readJson(req);
    const reason =
      typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string"
        ? body.reason
        : "Requested from the dashboard";
    const result = await invokeAction(principal, BUILTIN_TICKETS_ID, "delete_ticket", { ticketId: id, reason });
    return toResponse(result, result.ok && result.data.status === "pending" ? 202 : 200);
  });
}
