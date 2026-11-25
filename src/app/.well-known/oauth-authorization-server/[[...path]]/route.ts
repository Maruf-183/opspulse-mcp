import { NextRequest, NextResponse } from "next/server";
import { internalBaseUrl } from "@/lib/security/origins";

/** RFC 8414 authorization server metadata for MCP clients. */
export async function GET(req: NextRequest) {
  const origin = internalBaseUrl(req.headers.get("host"));
  return NextResponse.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["opspulse"],
    },
    { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
  );
}
