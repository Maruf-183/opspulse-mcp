import { z } from "zod";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, tickets } from "@/db/schema";
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
// Read models
// ---------------------------------------------------------------------------

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
