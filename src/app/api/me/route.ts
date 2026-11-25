import { connection, NextRequest, NextResponse } from "next/server";
import { permissionsOf } from "@/lib/authz/policy";
import { currentUser } from "@/lib/auth/accounts";
import { browserPrincipal, getOrCreateSandbox, handleRouteError, setSessionCookie } from "@/lib/http";

/**
 * GET /api/me — who is using the dashboard and what they may do. Issues an
 * anonymous demo workspace to visitors who are not signed in.
 */
export async function GET(req: NextRequest) {
  // Per-request (reads cookies); stop prerendering before the try/catch below.
  await connection();
  try {
    const user = await currentUser(req);
    const { sandboxId, isNew } = user ? { sandboxId: user.workspaceId, isNew: false } : getOrCreateSandbox(req);
    const principal = browserPrincipal(sandboxId);
    const res = NextResponse.json({
      data: {
        user: user ? { login: user.login, name: user.name, avatarUrl: user.avatarUrl } : null,
        role: principal.role,
        permissions: permissionsOf(principal),
        mcpUrl: `${req.nextUrl.origin}/api/mcp/mcp`,
      },
    });
    if (isNew) setSessionCookie(res, sandboxId);
    return res;
  } catch (error) {
    return handleRouteError(error);
  }
}
