import { z } from "zod";
import { db } from "@/db";
import { tickets, deletionRequests, auditLogs } from "@/db/schema";
import { eq, and, lt, desc } from "drizzle-orm";

// ১. ইনপুট ভ্যালিডেশন স্কিমা (Zod)
export const createTicketSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(120),
  description: z.string().min(5, "Description must be at least 5 characters").max(1000),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
});

export const listTicketsSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});

export const requestDeletionSchema = z.object({
  ticketId: z.number().int().positive("Ticket ID must be a positive integer"),
  reason: z.string().min(3, "Please provide a short reason for deletion").max(300),
});

// ২. অডিট লগ হেল্পার
export async function logMcpAudit(params: {
  sandboxId: string;
  action: string;
  inputPayload: unknown;
  outputPayload: unknown;
  latencyMs: number;
  isError?: boolean;
}) {
  await db.insert(auditLogs).values({
    sandboxId: params.sandboxId,
    action: params.action,
    inputPayload: JSON.stringify(params.inputPayload),
    outputPayload: JSON.stringify(params.outputPayload),
    latencyMs: params.latencyMs,
    isError: params.isError ? 1 : 0,
  });
}

// ৩. Lazy Cleanup: প্রতি রিকোয়েস্টে ২৪ ঘণ্টার পুরোনো মেয়াদোত্তীর্ণ টিকিট পরিষ্কার করা
export async function cleanupExpiredSandboxes() {
  const now = new Date();
  await db.delete(tickets).where(lt(tickets.expiresAt, now));
}

// ৪. নতুন টিকিট তৈরি
export async function createTicket(sandboxId: string, rawInput: unknown) {
  const start = Date.now();
  await cleanupExpiredSandboxes();

  const parsed = createTicketSchema.safeParse(rawInput);
  if (!parsed.success) {
    const err = parsed.error.flatten().fieldErrors;
    await logMcpAudit({
      sandboxId,
      action: "tool:create_ticket",
      inputPayload: rawInput,
      outputPayload: err,
      latencyMs: Date.now() - start,
      isError: true,
    });
    return { ok: false as const, error: `Validation failed: ${JSON.stringify(err)}` };
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // ২৪ ঘণ্টা মেয়াদ
  const [created] = await db
    .insert(tickets)
    .values({
      sandboxId,
      title: parsed.data.title,
      description: parsed.data.description,
      priority: parsed.data.priority,
      status: "OPEN",
      expiresAt,
    })
    .returning();

  await logMcpAudit({
    sandboxId,
    action: "tool:create_ticket",
    inputPayload: parsed.data,
    outputPayload: created,
    latencyMs: Date.now() - start,
  });

  return { ok: true as const, data: created };
}

// ৫. টিকিট তালিকা দেখা (শুধুমাত্র বর্তমান sandboxId-এর টিকিট)
export async function listTickets(sandboxId: string, rawInput: unknown = {}) {
  const start = Date.now();
  await cleanupExpiredSandboxes();

  const parsed = listTicketsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false as const, error: "Invalid filter parameters" };
  }

  const conditions = [eq(tickets.sandboxId, sandboxId)];
  if (parsed.data.status) conditions.push(eq(tickets.status, parsed.data.status));
  if (parsed.data.priority) conditions.push(eq(tickets.priority, parsed.data.priority));

  const results = await db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(desc(tickets.createdAt));

  await logMcpAudit({
    sandboxId,
    action: "tool:list_tickets",
    inputPayload: parsed.data,
    outputPayload: { count: results.length },
    latencyMs: Date.now() - start,
  });

  return { ok: true as const, data: results };
}

// ৬. সার্ভার-সাইড HITL: AI সরাসরি ডিলিট করতে পারবে না, শুধু PENDING রিকোয়েস্ট বানাবে
export async function requestTicketDeletion(sandboxId: string, rawInput: unknown) {
  const start = Date.now();
  const parsed = requestDeletionSchema.safeParse(rawInput);

  if (!parsed.success) {
    const err = parsed.error.flatten().fieldErrors;
    return { ok: false as const, error: `Invalid input: ${JSON.stringify(err)}` };
  }

  // টিকিটটি আসলেই এই স্যান্ডবক্সে আছে কি না যাচাই করা
  const [existing] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, parsed.data.ticketId), eq(tickets.sandboxId, sandboxId)));

  if (!existing) {
    await logMcpAudit({
      sandboxId,
      action: "tool:request_ticket_deletion",
      inputPayload: parsed.data,
      outputPayload: { error: "Ticket not found in current sandbox" },
      latencyMs: Date.now() - start,
      isError: true,
    });
    return {
      ok: false as const,
      error: `Ticket #${parsed.data.ticketId} not found in your sandbox. Use list_tickets first to verify the ID.`,
    };
  }

  const [request] = await db
    .insert(deletionRequests)
    .values({
      sandboxId,
      ticketId: existing.id,
      reason: parsed.data.reason,
      status: "PENDING",
    })
    .returning();

  await logMcpAudit({
    sandboxId,
    action: "tool:request_ticket_deletion",
    inputPayload: parsed.data,
    outputPayload: { approvalId: request?.id, status: "PENDING" },
    latencyMs: Date.now() - start,
  });

  return {
    ok: true as const,
    data: {
      approvalId: request?.id,
      ticketId: existing.id,
      ticketTitle: existing.title,
      status: "PENDING_HUMAN_APPROVAL",
      message: "Deletion request created. A human operator must click Approve in the UI to permanently delete this ticket.",
    },
  };
}

// ৭. আসল ডিলিট (শুধুমাত্র UI-এর Approve বাটন থেকে কল হবে)
export async function executeApprovedDeletion(sandboxId: string, approvalId: number, approve: boolean) {
  const [req] = await db
    .select()
    .from(deletionRequests)
    .where(and(eq(deletionRequests.id, approvalId), eq(deletionRequests.sandboxId, sandboxId)));

  if (!req || req.status !== "PENDING") {
    return { ok: false as const, error: "Pending approval request not found." };
  }

  if (!approve) {
    await db
      .update(deletionRequests)
      .set({ status: "REJECTED", resolvedAt: new Date() })
      .where(eq(deletionRequests.id, approvalId));
    return { ok: true as const, status: "REJECTED" };
  }

  await db
    .delete(tickets)
    .where(and(eq(tickets.id, req.ticketId), eq(tickets.sandboxId, sandboxId)));

  await db
    .update(deletionRequests)
    .set({ status: "APPROVED", resolvedAt: new Date() })
    .where(eq(deletionRequests.id, approvalId));

  await logMcpAudit({
    sandboxId,
    action: "hitl:approved_deletion",
    inputPayload: { approvalId, ticketId: req.ticketId },
    outputPayload: { deleted: true },
    latencyMs: 5,
  });

  return { ok: true as const, status: "APPROVED", deletedTicketId: req.ticketId };
}

// ৮. Resources-এর জন্য ডেটা রিড ফাংশন
export async function getRecentAuditLogs(sandboxId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.sandboxId, sandboxId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(20);
}
