import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setUserCookies, upsertUser } from "@/lib/auth/accounts";
import { getEnv } from "@/lib/env";
import { safeEqual } from "@/lib/security/crypto";
import { internalBaseUrl } from "@/lib/security/origins";
import { verifyValue } from "@/lib/security/session";

const profileSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

/** GET /api/auth/google/callback — Google sends the person back here. */
export async function GET(req: NextRequest) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getEnv();
  const origin = internalBaseUrl(req.headers.get("host"));
  const fail = (reason: string) => NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return fail("not_configured");

  const stored = verifyValue("google-state", req.cookies.get("opspulse_google_state")?.value);
  const [expectedState, verifier, next = "/dashboard"] = (stored ?? "").split("|");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const code = req.nextUrl.searchParams.get("code");
  if (!stored || !expectedState || !verifier || !safeEqual(state, expectedState) || !code) return fail("state");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: `${origin}/api/auth/google/callback`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokens = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokens.access_token) return fail("google_token");

  // Profile comes straight from Google over TLS using the fresh access token,
  // so the ID token's signature doesn't need separate verification here.
  const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const profile = profileSchema.safeParse(await profileRes.json().catch(() => null));
  if (!profile.success) return fail("google_profile");

  const email = profile.data.email_verified ? (profile.data.email ?? null) : null;
  const user = await upsertUser({
    provider: "google",
    providerId: profile.data.sub,
    login: email?.split("@")[0] ?? `user-${profile.data.sub.slice(-6)}`,
    name: profile.data.name ?? null,
    avatarUrl: profile.data.picture ?? null,
    email,
  });
  const res = NextResponse.redirect(`${origin}${next}`);
  res.cookies.delete("opspulse_google_state");
  setUserCookies(res, user);
  return res;
}
