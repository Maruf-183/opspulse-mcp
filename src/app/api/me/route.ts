import { NextRequest, NextResponse } from "next/server";
import { permissionsOf } from "@/lib/authz/policy";
import { withBrowserPrincipal } from "@/lib/http";

/** Who the caller is and what they may do — lets the UI hide controls it cannot use. */
export async function GET(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) =>
    NextResponse.json({
      data: {
        kind: principal.kind,
        role: principal.role,
        sandboxId: principal.sandboxId,
        permissions: permissionsOf(principal),
      },
    }),
  );
}
