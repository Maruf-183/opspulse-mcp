import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { eq } from "drizzle-orm";

const IP_LIMIT_PER_MIN = 12;
const GLOBAL_DAILY_LIMIT = 250;

export async function checkRateLimitAndCircuitBreaker(ip: string) {
  const now = new Date();

  // ১. গ্লোবাল দৈনিক সার্কিট ব্রেকার চেক (আজকের তারিখ অনুযায়ী)
  const todayKey = `global:${now.toISOString().slice(0, 10)}`;
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);

  const [globalRow] = await db
    .select()
    .from(rateLimits)
    .where(eq(rateLimits.key, todayKey));

  if (globalRow && globalRow.resetAt > now) {
    if (globalRow.count >= GLOBAL_DAILY_LIMIT) {
      return {
        allowed: false as const,
        reason: "CIRCUIT_BREAKER_OPEN",
        message: "Daily global AI demo quota reached. System is in Read-Only mode until tomorrow.",
      };
    }
    await db
      .update(rateLimits)
      .set({ count: globalRow.count + 1 })
      .where(eq(rateLimits.key, todayKey));
  } else {
    await db
      .insert(rateLimits)
      .values({ key: todayKey, count: 1, resetAt: tomorrow })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { count: 1, resetAt: tomorrow },
      });
  }

  // ২. প্রতি-আইপি রেট লিমিট চেক (প্রতি মিনিটে ১২টি রিকোয়েস্ট)
  const ipKey = `ip:${ip}`;
  const oneMinLater = new Date(now.getTime() + 60 * 1000);

  const [ipRow] = await db
    .select()
    .from(rateLimits)
    .where(eq(rateLimits.key, ipKey));

  if (ipRow && ipRow.resetAt > now) {
    if (ipRow.count >= IP_LIMIT_PER_MIN) {
      return {
        allowed: false as const,
        reason: "RATE_LIMITED",
        message: "Too many requests. Please wait a minute before sending another message.",
      };
    }
    await db
      .update(rateLimits)
      .set({ count: ipRow.count + 1 })
      .where(eq(rateLimits.key, ipKey));
  } else {
    await db
      .insert(rateLimits)
      .values({ key: ipKey, count: 1, resetAt: oneMinLater })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { count: 1, resetAt: oneMinLater },
      });
  }

  return { allowed: true as const };
}
