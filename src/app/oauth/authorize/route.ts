import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUser, type User } from "@/lib/auth/accounts";
import { authorizeParamsSchema, getClient, issueCode, type AuthorizeParams } from "@/lib/auth/oauth";
import { internalBaseUrl, isAllowedOrigin } from "@/lib/security/origins";
import { signValue, verifyValue } from "@/lib/security/session";

/**
 * GET  /oauth/authorize — "Allow <app> to use OpsPulse?" consent screen.
 * POST /oauth/authorize — the person's decision (Allow / Cancel).
 *
 * Plain server-rendered HTML: no client JavaScript, works on any phone.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fingerprint = (userId: string, params: AuthorizeParams) =>
  createHash("sha256").update(`${userId}|${JSON.stringify(params)}`).digest("hex");

function page(title: string, body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · OpsPulse</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#0f172a;--muted:#5b6475;--line:#e3e6ec;--accent:#2563eb;--ok:#0f7a4a;--no:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#131722;--ink:#e8ebf2;--muted:#9aa3b5;--line:#252b38;--accent:#5b8cff;--ok:#3ccf8e;--no:#ff7a6b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;color:var(--muted);font-size:14px;margin-bottom:20px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
ul{list-style:none;padding:0;margin:0 0 20px;border-top:1px solid var(--line)}li{padding:12px 0;border-bottom:1px solid var(--line);display:flex;gap:10px}
.y{color:var(--ok);font-weight:700}.n{color:var(--no);font-weight:700}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.who{font-size:14px;color:var(--muted);margin-top:16px;text-align:center}
</style></head><body><main class="card"><div class="brand"><span class="dot"></span>OpsPulse</div>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } },
  );
}

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
    return NextResponse.redirect(`${internalBaseUrl(req.headers.get("host"))}/api/auth/github?next=${encodeURIComponent(next)}`);
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
