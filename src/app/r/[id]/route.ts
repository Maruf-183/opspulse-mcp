import { NextRequest, NextResponse } from "next/server";
import { approveRequest, getRequest, rejectRequest, undoRequest } from "@/gateway/service";
import type { ActionRequestDTO } from "@/gateway/types";
import { browserPrincipal, getSandboxFromCookie } from "@/lib/http";
import { internalBaseUrl, isAllowedOrigin } from "@/lib/security/origins";
import { signValue, verifyValue } from "@/lib/security/session";
import { esc, page } from "@/lib/ui/html-page";

/**
 * /r/:id — one request, one decision. The AI puts this link in the chat so
 * people can approve, decline or undo without opening a dashboard.
 *
 * Only a signed-in human whose workspace owns the request can act: the AI
 * has no browser session, so fetching the link gets it a sign-in redirect,
 * and every decision needs a form token bound to this person and request.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Verb = "approve" | "reject" | "undo";

const STATUS_TEXT: Record<string, string> = {
  executed: "Done.",
  rejected: "You declined this. Nothing was changed.",
  expired: "This request expired, so nothing was changed.",
  denied: "Your rules don't allow this, so it was blocked.",
  failed: "This was approved but the project reported a problem.",
  undone: "This was undone.",
  approved: "Approved — it's running now.",
};

function changesTable(r: ActionRequestDTO) {
  const rows = r.preview?.changes ?? [];
  if (!rows.length) return "";
  const cell = "padding:8px 10px;border-top:1px solid var(--line);vertical-align:top";
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px;border:1px solid var(--line);border-radius:10px;overflow:hidden">
<tr style="color:var(--muted);font-size:12px;text-align:left"><th style="padding:8px 10px">What</th><th style="padding:8px 10px">Now</th><th style="padding:8px 10px">After</th></tr>
${rows
  .map(
    (c) =>
      `<tr><td style="${cell};font-weight:600">${esc(c.label)}</td><td style="${cell};color:var(--muted)">${esc(c.before ?? "—")}</td><td style="${cell}">${esc(c.after ?? "Removed")}</td></tr>`,
  )
  .join("")}</table>`;
}

function view(r: ActionRequestDTO, sandboxId: string, note?: string) {
  const token = (verb: Verb) => signValue("decide", `${verb}|${r.id}|${sandboxId}`);
  const form = (verbs: Array<[Verb, string, boolean]>) =>
    `<form method="post"><div class="row">${verbs
      .map(
        ([verb, label, primary]) =>
          `<button type="submit" name="verb" value="${verb}" ${primary ? 'class="primary"' : ""} formaction="?t=${encodeURIComponent(token(verb))}">${label}</button>`,
      )
      .join("")}</div></form>`;

  const header = `<p style="font-size:13px;margin:0 0 6px">${esc(r.projectName)}</p><h1>${esc(r.summary)}</h1>`;
  const reasons = r.reasons.length ? `<p><b>Why you're being asked:</b> ${esc(r.reasons.join(" "))}</p>` : "";
  const warnings = (r.preview?.warnings ?? [])
    .map((w) => `<p style="color:var(--no);font-weight:600">⚠ ${esc(w)}</p>`)
    .join("");
  const flash = note ? `<p style="color:var(--ok);font-weight:600">${esc(note)}</p>` : "";

  if (r.status === "pending") {
    return page("Approve?", `${flash}${header}<p>The AI wants to do this. Nothing happens until you decide.</p>${reasons}${changesTable(r)}${warnings}${form([["reject", "Decline", false], ["approve", "Allow", true]])}<p class="who">You can close this tab afterwards and go back to your chat.</p>`);
  }
  if (r.status === "executed" && r.undoUntil) {
    const minutes = Math.max(1, Math.round((Date.parse(r.undoUntil) - Date.now()) / 60000));
    return page("Done", `${flash}${header}<p>Done. You can still undo this for about ${minutes} minute${minutes === 1 ? "" : "s"}.</p>${changesTable(r)}${form([["undo", "Undo", false]])}`);
  }
  const extra = r.status === "failed" && r.error ? `<p>${esc(r.error)}</p>` : r.status === "expired" && r.error ? `<p>${esc(r.error)}</p>` : "";
  return page("Request", `${flash}${header}<p>${esc(STATUS_TEXT[r.status] ?? r.status)}</p>${extra}`);
}

function signInRedirect(req: NextRequest, id: string) {
  const origin = internalBaseUrl(req.headers.get("host"));
  return NextResponse.redirect(`${origin}/api/auth/github?next=${encodeURIComponent(`/r/${id}`)}`);
}

const notFound = () =>
  page("Not found", "<h1>We couldn't find this request</h1><p>It may belong to another account. Sign in with the account you use in your AI app.</p>", 404);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const sandboxId = getSandboxFromCookie(req);
  if (!sandboxId) return signInRedirect(req, id);
  const result = await getRequest(browserPrincipal(sandboxId), id);
  return result.ok ? view(result.data, sandboxId) : notFound();
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id) || !isAllowedOrigin(req.headers.get("origin"))) return notFound();
  const sandboxId = getSandboxFromCookie(req);
  if (!sandboxId) return signInRedirect(req, id);

  const verb = new URLSearchParams(await req.text()).get("verb") as Verb | null;
  const signed = verifyValue("decide", req.nextUrl.searchParams.get("t"));
  if (!verb || signed !== `${verb}|${id}|${sandboxId}`) {
    return page("Expired", "<h1>This page expired</h1><p>Reload it and try again.</p>", 400);
  }

  const principal = browserPrincipal(sandboxId);
  const run = { approve: approveRequest, reject: rejectRequest, undo: undoRequest }[verb];
  const outcome = await run(principal, id);
  const latest = await getRequest(principal, id);
  if (!latest.ok) return notFound();
  const note = outcome.ok
    ? { approve: "Allowed.", reject: "Declined.", undo: "Undone." }[verb]
    : outcome.error;
  return view(latest.data, sandboxId, note);
}
