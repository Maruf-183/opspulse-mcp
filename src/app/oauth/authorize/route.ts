import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth/accounts";
import { authorizeParamsSchema, getClient, issueCode, type AuthorizeParams } from "@/lib/auth/oauth";
import { internalBaseUrl, isAllowedOrigin } from "@/lib/security/origins";
import { signValue, verifyValue } from "@/lib/security/session";
import { esc, page } from "@/lib/ui/html-page";

/**
 * GET  /oauth/authorize — "Allow <app> to use OpsPulse?" consent screen.
 * POST /oauth/authorize — the person's decision (Allow / Cancel).
 *
 * Plain server-rendered HTML: no client JavaScript, works on any phone.
 */

const fingerprint = (userId: string, params: AuthorizeParams) =>
  createHash("sha256").update(`${userId}|${JSON.stringify(params)}`).digest("hex");


const problem = (message: string) =>
  page("Can't connect", `<h1>This connection link isn't valid</h1><p>${esc(message)}</p><p>Go back to your AI app and try connecting again.</p>`, 400);

async function validate(raw: Record<string, string>) {
  const parsed = authorizeParamsSchema.safeParse(raw);
  if (!parsed.success) return { error: "The app sent an incomplete request." } as const;
  const client = await getClient(parsed.data.client_id);
  if (!client) return { error: "The app isn't registered with OpsPulse." } as const;
  if (!client.redirectUris.includes(parsed.data.redirect_uri)) return { error: "The app's return address doesn't match." } as const;
  return { params: parsed.data, client } as const;
}

function consent(req: NextRequest, user: User, params: AuthorizeParams, appName: string) {
  const token = signValue("consent", fingerprint(user.id, params));
  const hidden = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join("");
  return page(
    `Connect ${appName}`,
    `<h1>Let ${esc(appName)} work with your projects?</h1>
<p>${esc(appName)} will act for you, always within the rules you set in OpsPulse.</p>
<ul>
<li><span class="y">✓</span><span>See your connected projects and what can be done in them</span></li>
<li><span class="y">✓</span><span>Do things you allow, or ask you first when your rules say so</span></li>
<li><span class="n">✕</span><span>Approve its own requests or change your rules — only you can</span></li>
</ul>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="consent_token" value="${esc(token)}">
<div class="row"><button type="submit" name="decision" value="deny">Cancel</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div></form>
<p class="who">Signed in as ${esc(user.name ?? user.login)}. You can disconnect any time from your dashboard.</p>`,
  );
}

export async function GET(req: NextRequest) {
  const raw = Object.fromEntries(req.nextUrl.searchParams);
  const checked = await validate(raw);
  if ("error" in checked) return problem(checked.error!);

  const user = await currentUser(req);
  if (!user) {
    const next = `/oauth/authorize?${req.nextUrl.searchParams.toString()}`;
    return NextResponse.redirect(`${internalBaseUrl(req.headers.get("host"))}/login?next=${encodeURIComponent(next)}`);
  }
  return consent(req, user, checked.params, checked.client.clientName);
}

export async function POST(req: NextRequest) {
  if (!isAllowedOrigin(req.headers.get("origin"))) return problem("This form must be sent from OpsPulse.");
  const form = Object.fromEntries(new URLSearchParams(await req.text()));
  const { decision, consent_token: consentToken, ...raw } = form;

  const checked = await validate(raw);
  if ("error" in checked) return problem(checked.error!);
  const user = await currentUser(req);
  if (!user) return problem("Your sign-in expired.");
  // The form token binds this decision to this user and these exact parameters.
  if (verifyValue("consent", consentToken) !== fingerprint(user.id, checked.params)) {
    return problem("This approval form expired or was changed.");
  }

  const back = new URL(checked.params.redirect_uri);
  if (checked.params.state) back.searchParams.set("state", checked.params.state);
  if (decision !== "allow") {
    back.searchParams.set("error", "access_denied");
    return NextResponse.redirect(back, 303);
  }
  back.searchParams.set("code", await issueCode(checked.params, user.id));
  return NextResponse.redirect(back, 303);
}
