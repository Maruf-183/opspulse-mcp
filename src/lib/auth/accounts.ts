/**
 * Accounts: sign-in with GitHub, a signed user cookie, and the user's own
 * workspace. Logged-out visitors keep the anonymous demo workspace.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { SESSION_COOKIE, USER_COOKIE, sessionCookieOptions, signSandboxId, signValue, verifyValue } from "@/lib/security/session";

export type User = typeof users.$inferSelect;

const USER_MAX_AGE = 30 * 24 * 60 * 60;

export async function currentUser(req: NextRequest): Promise<User | null> {
  const userId = verifyValue("user", req.cookies.get(USER_COOKIE)?.value);
  if (!userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}

export async function getUser(userId: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}

export type Identity = {
  provider: "github" | "google";
  providerId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email?: string | null;
};

/** Creates the user on first sign-in, refreshes their profile afterwards. */
export async function upsertUser(identity: Identity): Promise<User> {
  const column = identity.provider === "github" ? users.githubId : users.googleId;
  const profile = { login: identity.login, name: identity.name, avatarUrl: identity.avatarUrl, email: identity.email ?? null };
  const [existing] = await db.select().from(users).where(eq(column, identity.providerId));
  if (existing) {
    const [updated] = await db.update(users).set(profile).where(eq(users.id, existing.id)).returning();
    return updated ?? existing;
  }
  const [created] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      ...(identity.provider === "github" ? { githubId: identity.providerId } : { googleId: identity.providerId }),
      ...profile,
      workspaceId: `sbx_${randomBytes(12).toString("hex")}`,
    })
    .returning();
  return created!;
}

/** Kept for the GitHub callback. */
export const upsertGithubUser = (p: { id: number; login: string; name: string | null; avatar_url: string | null }) =>
  upsertUser({ provider: "github", providerId: String(p.id), login: p.login, name: p.name, avatarUrl: p.avatar_url });

/** Signs the user in: user cookie + their workspace as the active workspace. */
export function setUserCookies(res: NextResponse, user: User) {
  res.cookies.set(USER_COOKIE, signValue("user", user.id), { ...sessionCookieOptions(), maxAge: USER_MAX_AGE });
  res.cookies.set(SESSION_COOKIE, signSandboxId(user.workspaceId), { ...sessionCookieOptions(), maxAge: USER_MAX_AGE });
}

export function clearUserCookies(res: NextResponse) {
  res.cookies.delete(USER_COOKIE);
  res.cookies.delete(SESSION_COOKIE);
}

/** Only same-site relative paths, so `next` can't redirect somewhere else. */
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}
