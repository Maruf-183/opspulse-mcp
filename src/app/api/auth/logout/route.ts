import { NextRequest, NextResponse } from "next/server";
import { clearUserCookies } from "@/lib/auth/accounts";
import { isAllowedOrigin } from "@/lib/security/origins";

/** POST /api/auth/logout */
export async function POST(req: NextRequest) {
  if (!isAllowedOrigin(req.headers.get("origin"))) {
    return NextResponse.json({ error: "Cross-origin request rejected.", code: "FORBIDDEN" }, { status: 403 });
  }
  const res = NextResponse.json({ data: { signedOut: true } });
  clearUserCookies(res);
  return res;
}
