import { NextRequest, NextResponse } from "next/server";
import { exchangeToken } from "@/lib/auth/oauth";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "cache-control": "no-store",
};

/** POST /api/oauth/token — authorization_code (PKCE) and refresh_token grants. */
export async function POST(req: NextRequest) {
  const type = req.headers.get("content-type") ?? "";
  const form = type.includes("application/json")
    ? new URLSearchParams((await req.json().catch(() => ({}))) as Record<string, string>)
    : new URLSearchParams(await req.text());

  const result = await exchangeToken(form);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, error_description: result.description }, { status: 400, headers });
  }
  return NextResponse.json(result.body, { headers });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "POST" } });
}
