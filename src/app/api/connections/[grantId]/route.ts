import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/accounts";
import { revokeGrant } from "@/lib/auth/oauth";
import { errorResponse } from "@/lib/http";
import { isAllowedOrigin } from "@/lib/security/origins";

/** DELETE /api/connections/:grantId — disconnect an AI app immediately. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ grantId: string }> }) {
  if (!isAllowedOrigin(req.headers.get("origin"))) return errorResponse("FORBIDDEN", "Cross-origin request rejected.");
  const user = await currentUser(req);
  if (!user) return errorResponse("UNAUTHENTICATED", "Sign in first.");
  const { grantId } = await params;
  if (!(await revokeGrant(user.id, grantId))) return errorResponse("NOT_FOUND", "Connection not found.");
  return NextResponse.json({ data: { disconnected: true } });
}
