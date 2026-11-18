import { sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";

export const IP_LIMIT_PER_MIN = 12;
export const GLOBAL_DAILY_LIMIT = 250;

/**
 * Atomically increments a fixed-window counter and returns the new count.
 * A single INSERT … ON CONFLICT statement avoids the read-then-write race
 * where concurrent requests could all read the same count.
 */
async function hit(key: string, windowEndsAt: Date): Promise<number> {
  // `timestamp without time zone` columns hold UTC wall-clock values (that is
  // how drizzle writes Dates), so raw SQL must pass UTC ISO strings too.
  const now = sql`${new Date().toISOString()}::timestamp`;
  const windowEnd = sql`${windowEndsAt.toISOString()}::timestamp`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt: windowEndsAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.resetAt} <= ${now} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${rateLimits.resetAt} <= ${now} THEN ${windowEnd} ELSE ${rateLimits.resetAt} END`,
      },
    })
    .returning({ count: rateLimits.count });
  return row?.count ?? 1;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "RATE_LIMITED" | "CIRCUIT_BREAKER_OPEN"; message: string };

/**
 * Per-IP limit is checked first, so a single abusive client that is already
 * blocked cannot burn through the shared daily AI quota.
 */
export async function checkRateLimitAndCircuitBreaker(ip: string): Promise<RateLimitDecision> {
  const now = new Date();

  const ipCount = await hit(`ip:${ip}`, new Date(now.getTime() + 60_000));
  if (ipCount > IP_LIMIT_PER_MIN) {
    return {
      allowed: false,
      reason: "RATE_LIMITED",
      message: "Too many requests. Please wait a minute before sending another message.",
    };
  }

  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  const globalCount = await hit(`global:${now.toISOString().slice(0, 10)}`, tomorrow);
  if (globalCount > GLOBAL_DAILY_LIMIT) {
    return {
      allowed: false,
      reason: "CIRCUIT_BREAKER_OPEN",
      message: "Daily AI demo quota reached. The assistant is read-only until tomorrow (UTC).",
    };
  }

  return { allowed: true };
}

/** Client IP as reported by the platform proxy (Vercel sets x-real-ip). */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
