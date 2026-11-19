import { NextRequest } from "next/server";
import { readJson, toResponse, withBrowserPrincipal } from "@/lib/http";
import { createProject, listProjects } from "@/gateway/service";

/** GET /api/projects */
export async function GET(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) => toResponse(await listProjects(principal)));
}

/** POST /api/projects  { manifest, upstreamHeaders? } — returns the signing secret once. */
export async function POST(req: NextRequest) {
  return withBrowserPrincipal(req, async (principal) =>
    toResponse(await createProject(principal, await readJson(req)), 201),
  );
}
