import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tickets, deletionRequests, auditLogs } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { cleanupExpiredSandboxes } from "@/services/ticket.service";
import crypto from "crypto";

export async function GET(req: NextRequest) {
  await cleanupExpiredSandboxes();

  let sandboxId = req.cookies.get("opspulse_sandbox")?.value;
  let isNewSandbox = false;

  if (!sandboxId) {
    sandboxId = `sbx_${crypto.randomBytes(6).toString("hex")}`;
    isNewSandbox = true;
  }

  const [sandboxTickets, pendingApprovals, recentLogs] = await Promise.all([
    db
      .select()
      .from(tickets)
      .where(eq(tickets.sandboxId, sandboxId))
      .orderBy(desc(tickets.createdAt)),
    db
      .select()
      .from(deletionRequests)
      .where(
        and(
          eq(deletionRequests.sandboxId, sandboxId),
          eq(deletionRequests.status, "PENDING")
        )
      )
      .orderBy(desc(deletionRequests.createdAt)),
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.sandboxId, sandboxId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(25),
  ]);

  const response = NextResponse.json({
    sandboxId,
    tickets: sandboxTickets,
    pendingApprovals,
    auditLogs: recentLogs,
  });

  if (isNewSandbox) {
    response.cookies.set("opspulse_sandbox", sandboxId, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60, // ২৪ ঘণ্টা
      path: "/",
    });
  }

  return response;
}
