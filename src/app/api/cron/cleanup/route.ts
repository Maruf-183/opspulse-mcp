import { connection, NextRequest, NextResponse } from "next/server";
import { lt } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, deletionRequests, rateLimits, tickets } from "@/db/schema";
import { isProduction } from "@/lib/env";
import { hasBearer } from "@/lib/security/crypto";

export async function GET(request: NextRequest) {
  await connection();

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret && isProduction()) {
    // Fail closed: an unprotected destructive endpoint must not run in production.
    console.error("CRON_SECRET is not configured; refusing to run cleanup.");
    return NextResponse.json(
      { error: "Cleanup is not configured.", code: "INTERNAL" },
      { status: 500 },
    );
  }
  if (cronSecret && !hasBearer(request.headers.get("authorization"), cronSecret)) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
  }

  const now = new Date();
  const olderThan = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    const [expiredTickets, oldAuditLogs, oldDeletionRequests, oldRateLimits] = await Promise.all([
      db.delete(tickets).where(lt(tickets.expiresAt, now)).returning({ id: tickets.id }),
      db.delete(auditLogs).where(lt(auditLogs.createdAt, olderThan)).returning({ id: auditLogs.id }),
      db
        .delete(deletionRequests)
        .where(lt(deletionRequests.createdAt, olderThan))
        .returning({ id: deletionRequests.id }),
      db.delete(rateLimits).where(lt(rateLimits.resetAt, now)).returning({ key: rateLimits.key }),
    ]);

    return NextResponse.json({
      success: true,
      deleted: {
        tickets: expiredTickets.length,
        auditLogs: oldAuditLogs.length,
        deletionRequests: oldDeletionRequests.length,
        rateLimits: oldRateLimits.length,
      },
      completedAt: now.toISOString(),
    });
  } catch (error) {
    console.error("Cron cleanup failed:", error);
    return NextResponse.json(
      { error: "Cleanup failed. Check the server logs for details.", code: "INTERNAL" },
      { status: 500 },
    );
  }
}
