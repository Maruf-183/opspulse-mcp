import { NextRequest } from "next/server";
import { readJson, toResponse, withBrowserPrincipal } from "@/lib/http";
import { setActionTier } from "@/gateway/service";

/** PATCH /api/projects/:id/actions/:action  { tier } */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  return withBrowserPrincipal(req, async (principal) => {
    const body = await readJson(req);
    const tier = typeof body === "object" && body !== null && "tier" in body ? body.tier : undefined;
    return toResponse(await setActionTier(principal, id, action, tier));
  });
}
