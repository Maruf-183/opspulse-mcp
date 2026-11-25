import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/accounts";
import { listConnections } from "@/lib/auth/oauth";
import { errorResponse } from "@/lib/http";

/** GET /api/connections — AI apps the signed-in user has allowed. */
export async function GET(req: NextRequest) {
  const user = await currentUser(req);
  if (!user) return errorResponse("UNAUTHENTICATED", "Sign in to see your connected apps.");
  const connections = await listConnections(user.id);
  return NextResponse.json({ data: connections.map((c) => ({ ...c, connectedAt: c.connectedAt.toISOString() })) });
}
