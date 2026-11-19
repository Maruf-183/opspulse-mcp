import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { approveRequest } from "@/gateway/service";

/** POST /api/requests/:id/approve — humans only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withBrowserPrincipal(req, async (principal) => toResponse(await approveRequest(principal, id)));
}
