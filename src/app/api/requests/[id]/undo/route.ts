import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { undoRequest } from "@/gateway/service";

/** POST /api/requests/:id/undo — humans only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withBrowserPrincipal(req, async (principal) => toResponse(await undoRequest(principal, id)));
}
