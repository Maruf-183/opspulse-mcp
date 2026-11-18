import { NextRequest } from "next/server";
import { readJson, toResponse, withBrowserPrincipal } from "@/lib/http";
import { createTicket, listTickets } from "@/services/ticket.service";

/** GET /api/tickets?status=OPEN&priority=HIGH&limit=50 */
export async function GET(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) => {
    const params = req.nextUrl.searchParams;
    const filters = {
      status: params.get("status") ?? undefined,
      priority: params.get("priority") ?? undefined,
      limit: params.get("limit") ?? undefined,
    };
    return toResponse(await listTickets(principal, filters));
  });
}

/** POST /api/tickets  { title, description, priority? } */
export async function POST(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) =>
    toResponse(await createTicket(principal, await readJson(req)), 201),
  );
}
