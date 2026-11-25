import { NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/accounts";
import { getEnv } from "@/lib/env";
import { esc, page } from "@/lib/ui/html-page";

const ERRORS: Record<string, string> = {
  state: "The sign-in took too long or was opened in another browser. Please try again.",
  not_configured: "This sign-in option isn't available yet.",
};

/** GET /login?next=/somewhere — choose how to sign in. Plain HTML, works everywhere. */
export function GET(req: NextRequest) {
  const env = getEnv();
  const next = encodeURIComponent(safeNext(req.nextUrl.searchParams.get("next")));
  const error = req.nextUrl.searchParams.get("error");
  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${href}" style="display:block;text-align:center;text-decoration:none;font-weight:600;padding:12px;border-radius:10px;margin-bottom:10px;${
      primary ? "background:var(--accent);color:#fff;border:1px solid var(--accent)" : "border:1px solid var(--line);color:var(--ink)"
    }">${label}</a>`;

  return page(
    "Sign in",
    `<h1>Sign in to OpsPulse</h1>
<p>Use the account you want your workspace to belong to.</p>
${error ? `<p style="color:var(--no);font-weight:600">${esc(ERRORS[error] ?? "Something went wrong. Please try again.")}</p>` : ""}
${env.GOOGLE_CLIENT_ID ? button(`/api/auth/google?next=${next}`, "Continue with Google", true) : ""}
${env.GITHUB_CLIENT_ID ? button(`/api/auth/github?next=${next}`, "Continue with GitHub", !env.GOOGLE_CLIENT_ID) : ""}
<p class="who">We only read your name, email and profile picture.</p>`,
  );
}
