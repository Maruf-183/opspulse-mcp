import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { safeNext } from "@/lib/auth/accounts";
import { getEnv } from "@/lib/env";
import { internalBaseUrl } from "@/lib/security/origins";
import { sessionCookieOptions, signValue } from "@/lib/security/session";

/** GET /api/auth/github?next=/dashboard — starts "Sign in with GitHub". */
export async function GET(req: NextRequest) {
  const { GITHUB_CLIENT_ID } = getEnv();
  if (!GITHUB_CLIENT_ID) return NextResponse.json({ error: "GitHub sign-in is not configured." }, { status: 503 });

  const state = randomBytes(16).toString("base64url");
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const origin = internalBaseUrl(req.headers.get("host"));

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/api/auth/github/callback`);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");

  const res = NextResponse.redirect(url);
  // State + where to return, signed and bound to this browser for 10 minutes.
  res.cookies.set("opspulse_oauth_state", signValue("gh-state", `${state}|${next}`), { ...sessionCookieOptions(), maxAge: 600 });
  return res;
}
