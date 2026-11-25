import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { safeNext } from "@/lib/auth/accounts";
import { getEnv } from "@/lib/env";
import { internalBaseUrl } from "@/lib/security/origins";
import { sessionCookieOptions, signValue } from "@/lib/security/session";

/** GET /api/auth/google?next=/dashboard — "Continue with Google" (OIDC, PKCE). */
export async function GET(req: NextRequest) {
  const { GOOGLE_CLIENT_ID } = getEnv();
  if (!GOOGLE_CLIENT_ID) return NextResponse.json({ error: "Google sign-in is not configured." }, { status: 503 });

  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const origin = internalBaseUrl(req.headers.get("host"));

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/api/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  const res = NextResponse.redirect(url);
  res.cookies.set("opspulse_google_state", signValue("google-state", `${state}|${verifier}|${next}`), { ...sessionCookieOptions(), maxAge: 600 });
  return res;
}
