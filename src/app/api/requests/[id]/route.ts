import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { getRequest } from "@/gateway/service";

/** GET /api/requests/:id */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withBrowserPrincipal(req, async (principal) => toResponse(await getRequest(principal, id)));
}
