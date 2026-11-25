import { NextRequest, NextResponse } from "next/server";
import { registerClient } from "@/lib/auth/oauth";
import { allowPerMinute, clientIp } from "@/services/ratelimit.service";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };

/** POST /api/oauth/register — dynamic client registration (RFC 7591). */
export async function POST(req: NextRequest) {
  if (!(await allowPerMinute(`oauth-register:${clientIp(req.headers)}`, 10))) return NextResponse.json({ error: "slow_down" }, { status: 429, headers: cors });

  const result = await registerClient(await req.json().catch(() => null));
  if (!result.ok) {
    return NextResponse.json({ error: result.error, error_description: "Invalid client metadata" }, { status: 400, headers: cors });
  }
  return NextResponse.json(result.client, { status: 201, headers: cors });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST" } });
}
