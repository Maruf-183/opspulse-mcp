import { z } from "zod";
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, deletionRequests, tickets } from "@/db/schema";
import { can, type Permission, type Principal } from "@/lib/authz/policy";
import { fail, ok, type Fail, type ServiceResult } from "./result";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const PRIORITY = z.enum(["LOW", "MEDIUM", "HIGH"]);
const STATUS = z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]);
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

export const createTicketSchema = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(120),
  description: z.string().trim().min(5, "Description must be at least 5 characters").max(1000),
  priority: PRIORITY.default("MEDIUM"),
});

export const listTicketsSchema = z.object({
  status: STATUS.optional(),
  priority: PRIORITY.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const updateTicketSchema = z
  .object({ status: STATUS.optional(), priority: PRIORITY.optional() })
  .refine((value) => value.status !== undefined || value.priority !== undefined, {
    message: "Provide at least one of status or priority",
  });

export const ticketIdSchema = z.number().int().positive("Ticket ID must be a positive integer");

export const requestDeletionSchema = z.object({
  ticketId: ticketIdSchema,
  reason: z.string().trim().min(3, "Please provide a short reason for deletion").max(300),
});

// ---------------------------------------------------------------------------
// Audit + authorization helpers
// ---------------------------------------------------------------------------

export async function logAudit(params: {
  principal: Principal;
  action: string;
  input: unknown;
  output: unknown;
  startedAt: number;
  isError?: boolean;
}) {
  await db.insert(auditLogs).values({
    sandboxId: params.principal.sandboxId,
    action: params.action,
    inputPayload: JSON.stringify({ actor: params.principal.id, input: params.input ?? null }),
    outputPayload: JSON.stringify(params.output ?? null),
    latencyMs: Date.now() - params.startedAt,
    isError: params.isError ? 1 : 0,
  });
}

/** Denials are audited too, so attempted privilege use is visible. */
async function guard(
  principal: Principal,
  permission: Permission,
  action: string,
  input: unknown,
  startedAt: number,
): Promise<Fail | null> {
  if (can(principal, permission)) return null;
  const denied = fail(
    "FORBIDDEN",
    `${principal.kind === "agent" ? "AI agents" : `Role "${principal.role}"`} cannot perform ${permission}.`,
  );
  await logAudit({ principal, action, input, output: { denied: permission }, startedAt, isError: true });
  return denied;
}

async function validationFailed(
  principal: Principal,
  action: string,
  input: unknown,
  error: z.ZodError,
  startedAt: number,
): Promise<Fail> {
  const details = z.flattenError(error);
  await logAudit({ principal, action, input, output: details, startedAt, isError: true });
  return fail("VALIDATION_FAILED", "Validation failed.", details);
}

const activeTicket = (principal: Principal, ticketId: number) =>
  and(
    eq(tickets.id, ticketId),
    eq(tickets.sandboxId, principal.sandboxId),
    gt(tickets.expiresAt, new Date()),
  );

export type TicketRow = typeof tickets.$inferSelect;

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export async function createTicket(
  principal: Principal,
  rawInput: unknown,
): Promise<ServiceResult<TicketRow>> {
  const startedAt = Date.now();
  const action = "ticket:create";
  const denied = await guard(principal, "ticket:create", action, rawInput, startedAt);
  if (denied) return denied;

  const parsed = createTicketSchema.safeParse(rawInput);
  if (!parsed.success) return validationFailed(principal, action, rawInput, parsed.error, startedAt);

  const [created] = await db
    .insert(tickets)
    .values({
      sandboxId: principal.sandboxId,
      ...parsed.data,
      status: "OPEN",
      expiresAt: new Date(Date.now() + TICKET_TTL_MS),
    })
    .returning();

  if (!created) return fail("INTERNAL", "Ticket could not be created.");
  await logAudit({ principal, action, input: parsed.data, output: { id: created.id }, startedAt });
  return ok(created);
}

export async function listTickets(
  principal: Principal,
  rawInput: unknown = {},
): Promise<ServiceResult<TicketRow[]>> {
  const startedAt = Date.now();
  const action = "ticket:list";
  const denied = await guard(principal, "ticket:read", action, rawInput, startedAt);
  if (denied) return denied;

  const parsed = listTicketsSchema.safeParse(rawInput ?? {});
  if (!parsed.success) return validationFailed(principal, action, rawInput, parsed.error, startedAt);

  const conditions = [eq(tickets.sandboxId, principal.sandboxId), gt(tickets.expiresAt, new Date())];
  if (parsed.data.status) conditions.push(eq(tickets.status, parsed.data.status));
  if (parsed.data.priority) conditions.push(eq(tickets.priority, parsed.data.priority));

  const rows = await db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(desc(tickets.createdAt))
    .limit(parsed.data.limit);

  // Agent reads are audited (they show what the AI looked at); dashboard
  // refreshes are not, so polling does not flood the audit trail.
  if (principal.kind === "agent") {
    await logAudit({ principal, action, input: parsed.data, output: { count: rows.length }, startedAt });
  }
  return ok(rows);
}

export async function getTicket(
  principal: Principal,
  ticketId: number,
): Promise<ServiceResult<TicketRow>> {
  if (!can(principal, "ticket:read")) return fail("FORBIDDEN", "Not allowed to read tickets.");
  const [row] = await db.select().from(tickets).where(activeTicket(principal, ticketId));
  return row ? ok(row) : fail("NOT_FOUND", `Ticket #${ticketId} not found in this workspace.`);
}

export async function updateTicket(
  principal: Principal,
  ticketId: number,
  rawInput: unknown,
): Promise<ServiceResult<TicketRow>> {
  const startedAt = Date.now();
  const action = "ticket:update";
  const input = { ticketId, changes: rawInput };
  const denied = await guard(principal, "ticket:update", action, input, startedAt);
  if (denied) return denied;

  const parsed = updateTicketSchema.safeParse(rawInput);
  if (!parsed.success) return validationFailed(principal, action, input, parsed.error, startedAt);

  const [updated] = await db
    .update(tickets)
    .set(parsed.data)
    .where(activeTicket(principal, ticketId))
    .returning();

  if (!updated) {
    await logAudit({ principal, action, input, output: { error: "not found" }, startedAt, isError: true });
    return fail("NOT_FOUND", `Ticket #${ticketId} not found in this workspace.`);
  }
  await logAudit({ principal, action, input: { ticketId, ...parsed.data }, output: { id: updated.id }, startedAt });
  return ok(updated);
}

// ---------------------------------------------------------------------------
// Deletion: request (agents and humans) → approve (humans only)
// ---------------------------------------------------------------------------

export type DeletionRequestResult = {
  approvalId: number;
  ticketId: number;
  ticketTitle: string;
  status: "PENDING_HUMAN_APPROVAL";
  alreadyPending: boolean;
  message: string;
};

export async function requestTicketDeletion(
  principal: Principal,
  rawInput: unknown,
): Promise<ServiceResult<DeletionRequestResult>> {
  const startedAt = Date.now();
  const action = "ticket:delete:request";
  const denied = await guard(principal, "ticket:delete:request", action, rawInput, startedAt);
  if (denied) return denied;

  const parsed = requestDeletionSchema.safeParse(rawInput);
  if (!parsed.success) return validationFailed(principal, action, rawInput, parsed.error, startedAt);
  const { ticketId, reason } = parsed.data;

  const [ticket] = await db.select().from(tickets).where(activeTicket(principal, ticketId));
  if (!ticket) {
    await logAudit({ principal, action, input: parsed.data, output: { error: "not found" }, startedAt, isError: true });
    return fail("NOT_FOUND", `Ticket #${ticketId} not found in this workspace. Use list_tickets to verify the ID.`);
  }

  const message =
    "Deletion request created. A human operator must approve it in the dashboard before the ticket is deleted.";

  const [existing] = await db
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.sandboxId, principal.sandboxId),
        eq(deletionRequests.ticketId, ticketId),
        eq(deletionRequests.status, "PENDING"),
      ),
    );

  if (existing) {
    return ok({
      approvalId: existing.id,
      ticketId,
      ticketTitle: ticket.title,
      status: "PENDING_HUMAN_APPROVAL",
      alreadyPending: true,
      message: "A deletion request for this ticket is already waiting for approval.",
    });
  }

  const [request] = await db
    .insert(deletionRequests)
    .values({ sandboxId: principal.sandboxId, ticketId, reason, status: "PENDING" })
    .returning({ id: deletionRequests.id });

  if (!request) return fail("INTERNAL", "Deletion request could not be created.");
  await logAudit({ principal, action, input: parsed.data, output: { approvalId: request.id }, startedAt });

  return ok({
    approvalId: request.id,
    ticketId,
    ticketTitle: ticket.title,
    status: "PENDING_HUMAN_APPROVAL",
    alreadyPending: false,
    message,
  });
}

export type ApprovalDecision =
  | { status: "APPROVED"; approvalId: number; deletedTicketId: number; ticketDeleted: boolean }
  | { status: "REJECTED"; approvalId: number };

export async function resolveDeletionRequest(
  principal: Principal,
  approvalId: number,
  approve: boolean,
): Promise<ServiceResult<ApprovalDecision>> {
  const startedAt = Date.now();
  const action = approve ? "hitl:approve_deletion" : "hitl:reject_deletion";
  const input = { approvalId };
  const denied = await guard(principal, "ticket:delete:approve", action, input, startedAt);
  if (denied) return denied;

  const sandbox = principal.sandboxId;
  const isPending = and(
    eq(deletionRequests.id, approvalId),
    eq(deletionRequests.sandboxId, sandbox),
    eq(deletionRequests.status, "PENDING"),
  );
  const notFound = fail("NOT_FOUND", "Pending approval request not found. It may already be resolved.");

  if (!approve) {
    const [rejected] = await db
      .update(deletionRequests)
      .set({ status: "REJECTED", resolvedAt: new Date() })
      .where(isPending)
      .returning({ id: deletionRequests.id, ticketId: deletionRequests.ticketId });
    if (!rejected) return notFound;
    await logAudit({ principal, action, input: { ...input, ticketId: rejected.ticketId }, output: { status: "REJECTED" }, startedAt });
    return ok({ status: "REJECTED", approvalId });
  }

  // One transaction: delete the ticket, claim the request, and close any
  // duplicate requests. The `status = 'PENDING'` predicates make concurrent
  // approve/reject clicks safe — only one of them can win the claim.
  const ticketOfRequest = db
    .select({ id: deletionRequests.ticketId })
    .from(deletionRequests)
    .where(and(eq(deletionRequests.id, approvalId), eq(deletionRequests.sandboxId, sandbox)));

  const [deleted, claimed] = await db.batch([
    db
      .delete(tickets)
      .where(
        and(
          eq(tickets.sandboxId, sandbox),
          inArray(
            tickets.id,
            db.select({ id: deletionRequests.ticketId }).from(deletionRequests).where(isPending),
          ),
        ),
      )
      .returning({ id: tickets.id }),
    db
      .update(deletionRequests)
      .set({ status: "APPROVED", resolvedAt: new Date() })
      .where(isPending)
      .returning({ ticketId: deletionRequests.ticketId }),
    db
      .update(deletionRequests)
      .set({ status: "REJECTED", resolvedAt: new Date() })
      .where(
        and(
          eq(deletionRequests.sandboxId, sandbox),
          eq(deletionRequests.status, "PENDING"),
          ne(deletionRequests.id, approvalId),
          inArray(deletionRequests.ticketId, ticketOfRequest),
        ),
      ),
  ]);

  const claim = claimed[0];
  if (!claim) return notFound;

  const result = {
    status: "APPROVED" as const,
    approvalId,
    deletedTicketId: claim.ticketId,
    ticketDeleted: deleted.length > 0,
  };
  await logAudit({ principal, action, input: { ...input, ticketId: claim.ticketId }, output: result, startedAt });
  return ok(result);
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export async function listPendingApprovals(principal: Principal) {
  if (!can(principal, "ticket:read")) return fail("FORBIDDEN", "Not allowed to read approvals.");
  // Inner join hides requests whose ticket has expired or been removed.
  const rows = await db
    .select({
      id: deletionRequests.id,
      ticketId: deletionRequests.ticketId,
      ticketTitle: tickets.title,
      reason: deletionRequests.reason,
      createdAt: deletionRequests.createdAt,
    })
    .from(deletionRequests)
    .innerJoin(tickets, eq(tickets.id, deletionRequests.ticketId))
    .where(
      and(
        eq(deletionRequests.sandboxId, principal.sandboxId),
        eq(deletionRequests.status, "PENDING"),
        eq(tickets.sandboxId, principal.sandboxId),
        gt(tickets.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(deletionRequests.createdAt));
  return ok(rows);
}

export async function getRecentAuditLogs(principal: Principal, limit = 25) {
  if (!can(principal, "audit:read")) {
    return fail("FORBIDDEN", "Not allowed to read audit logs.");
  }
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.sandboxId, principal.sandboxId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return ok(rows);
}

// ---------------------------------------------------------------------------
// Gateway-only primitives
// ---------------------------------------------------------------------------
// These skip the per-permission checks above because they are only called by
// the built-in gateway connector *after* the gateway has applied the
// workspace's tier rules (including human approval). Never call them from a
// route handler directly.

export async function deleteTicketForGateway(sandboxId: string, ticketId: number): Promise<TicketRow | null> {
  const [deleted] = await db
    .delete(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.sandboxId, sandboxId)))
    .returning();
  return deleted ?? null;
}

export async function restoreTicketFieldsForGateway(
  sandboxId: string,
  ticketId: number,
  fields: { status?: TicketRow["status"]; priority?: TicketRow["priority"] },
): Promise<TicketRow | null> {
  const [updated] = await db
    .update(tickets)
    .set(fields)
    .where(and(eq(tickets.id, ticketId), eq(tickets.sandboxId, sandboxId)))
    .returning();
  return updated ?? null;
}
