import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setUserCookies, upsertGithubUser } from "@/lib/auth/accounts";
import { getEnv } from "@/lib/env";
import { internalBaseUrl } from "@/lib/security/origins";
import { safeEqual } from "@/lib/security/crypto";
import { verifyValue } from "@/lib/security/session";

const githubUser = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable(),
  avatar_url: z.string().nullable(),
});

/** GET /api/auth/github/callback — GitHub sends the user back here. */
export async function GET(req: NextRequest) {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = getEnv();
  const origin = internalBaseUrl(req.headers.get("host"));
  const fail = (reason: string) => NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) return fail("not_configured");

  const stored = verifyValue("gh-state", req.cookies.get("opspulse_oauth_state")?.value);
  const [expectedState, next = "/dashboard"] = (stored ?? "").split("|");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const code = req.nextUrl.searchParams.get("code");
  if (!stored || !expectedState || !safeEqual(state, expectedState) || !code) return fail("state");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/api/auth/github/callback`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenJson.access_token) return fail("github_token");

  const profileRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/vnd.github+json", "user-agent": "OpsPulse" },
    signal: AbortSignal.timeout(10_000),
  });
  const profile = githubUser.safeParse(await profileRes.json().catch(() => null));
  if (!profile.success) return fail("github_profile");

  // The GitHub token is not stored: it is only used to read the profile once.
  const user = await upsertGithubUser(profile.data);
  const res = NextResponse.redirect(`${origin}${next}`);
  res.cookies.delete("opspulse_oauth_state");
  setUserCookies(res, user);
  return res;
}
