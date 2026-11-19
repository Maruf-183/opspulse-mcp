import { NextRequest } from "next/server";
import { toResponse, withBrowserPrincipal } from "@/lib/http";
import { deleteProject, getProject } from "@/gateway/service";

type Context = { params: Promise<{ id: string }> };

/** GET /api/projects/:id — project with per-action rules. */
export async function GET(req: NextRequest, { params }: Context) {
  const { id } = await params;
  return withBrowserPrincipal(req, async (principal) => toResponse(await getProject(principal, id)));
}

/** DELETE /api/projects/:id — disconnect a project; its pending requests expire. */
export async function DELETE(req: NextRequest, { params }: Context) {
  const { id } = await params;
  return withBrowserPrincipal(req, async (principal) => toResponse(await deleteProject(principal, id)));
}
