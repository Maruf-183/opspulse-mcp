import { NextRequest, NextResponse } from "next/server";
import { browserPrincipal, getOrCreateSandbox, handleRouteError, setSessionCookie } from "@/lib/http";
import { getRecentAuditLogs, listPendingApprovals, listTickets } from "@/services/ticket.service";

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
      listPendingApprovals(principal),
      getRecentAuditLogs(principal, 25),
    ]);

    const response = NextResponse.json({
      sandboxId,
      role: principal.role,
      tickets: tickets.ok ? tickets.data : [],
      pendingApprovals: pendingApprovals.ok ? pendingApprovals.data : [],
      auditLogs: auditLogs.ok ? auditLogs.data : [],
    });
    if (isNew) setSessionCookie(response, sandboxId);
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
