import { NextRequest } from "next/server";
import { errorResponse, parseId, readJson, toResponse, withBrowserPrincipal } from "@/lib/http";
import { getTicket, requestTicketDeletion, updateTicket } from "@/services/ticket.service";

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
 * Deletion is never immediate, for humans or agents: this creates a pending
 * approval (202 Accepted). Approve it with POST /api/approvals/:approvalId.
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
    return toResponse(await requestTicketDeletion(principal, { ticketId: id, reason }), 202);
  });
}
