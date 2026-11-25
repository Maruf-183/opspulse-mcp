import { NextRequest, NextResponse } from "next/server";
import { internalBaseUrl } from "@/lib/security/origins";

/**
 * RFC 9728 protected resource metadata. MCP clients fetch this after a 401
 * from /api/mcp/mcp to learn where to authorize. Served at the bare path and
 * at the path-suffixed form (`/.well-known/oauth-protected-resource/api/mcp/mcp`).
 */
export async function GET(req: NextRequest) {
  const origin = internalBaseUrl(req.headers.get("host"));
  return NextResponse.json(
    {
      resource: `${origin}/api/mcp/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "OpsPulse",
      resource_documentation: `${origin}/`,
    },
    { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
  );
}
