import { NextRequest, NextResponse } from "next/server";
import { browserPrincipal, getOrCreateSandbox, handleRouteError, setSessionCookie } from "@/lib/http";
import { getRecentAuditLogs, listTickets } from "@/services/ticket.service";
import { listRequests } from "@/gateway/service";
import { BUILTIN_TICKETS_ID } from "@/gateway/builtin/tickets";

/**
 * Dashboard snapshot. Also the entry point that issues a signed sandbox
 * session to new visitors; every other browser route requires one.
 */
export async function GET(req: NextRequest) {
  const { sandboxId, isNew } = getOrCreateSandbox(req);
  const principal = browserPrincipal(sandboxId);

  try {
    const [tickets, pendingApprovals, auditLogs] = await Promise.all([
      listTickets(principal, { limit: 100 }),
      listRequests(principal, "pending", 50),
      getRecentAuditLogs(principal, 25),
    ]);

    const response = NextResponse.json({
      sandboxId,
      role: principal.role,
      tickets: tickets.ok ? tickets.data : [],
      // Demo page shape: pending ticket deletions held by the gateway.
      pendingApprovals: pendingApprovals.ok
        ? pendingApprovals.data
            .filter((r) => r.projectId === BUILTIN_TICKETS_ID && r.action === "delete_ticket")
            .map((r) => ({
              id: r.id,
              ticketId: Number(r.input.ticketId),
              ticketTitle: r.preview?.changes[0]?.before ?? undefined,
              reason: typeof r.input.reason === "string" ? r.input.reason : r.summary,
            }))
        : [],
      auditLogs: auditLogs.ok ? auditLogs.data : [],
    });
    if (isNew) setSessionCookie(response, sandboxId);
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
