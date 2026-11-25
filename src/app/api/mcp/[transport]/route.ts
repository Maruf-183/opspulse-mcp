import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest, NextResponse } from "next/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type { Principal } from "@/lib/authz/policy";
import { getEnv } from "@/lib/env";
import { hasBearer } from "@/lib/security/crypto";
import { internalBaseUrl, isAllowedOrigin } from "@/lib/security/origins";
import { getUser } from "@/lib/auth/accounts";
import { verifyAccessToken } from "@/lib/auth/oauth";
import { SESSION_HEADER, verifySessionToken } from "@/lib/security/session";
import type { ServiceResult } from "@/services/result";
import { getRecentAuditLogs } from "@/services/ticket.service";
import { getRequest, invokeAction, TIER_LABEL } from "@/gateway/service";
import { matchProject, projectDirectory } from "@/gateway/directory";
import type { ActionRequestDTO } from "@/gateway/types";

/** Sandbox shared by external MCP clients (Cursor, Claude Desktop, …). */
const EXTERNAL_MCP_SANDBOX = "demo-sandbox";

/**
 * The principal is resolved once, in the route wrapper, from verified inputs
 * only, and carried to tool handlers through AsyncLocalStorage. Tool handlers
 * never read identity from headers themselves.
 */
const principalStorage = new AsyncLocalStorage<Principal>();
/** Public origin of this request, for links the AI shows to the person. */
const originStorage = new AsyncLocalStorage<string>();
const linkTo = (id: string) => `${originStorage.getStore() ?? ""}/r/${id}`;

function currentPrincipal(): Principal {
  const principal = principalStorage.getStore();
  if (!principal) throw new Error("MCP tool invoked outside an authenticated request.");
  return principal;
}

/**
 * Every MCP caller is an *agent*. A caller presenting a signed dashboard
 * session acts inside that user's sandbox (this is the in-app assistant);
 * any other caller with the shared key is confined to the demo sandbox.
 */
function resolveAgentPrincipal(req: NextRequest): Principal {
  const sandboxId = verifySessionToken(req.headers.get(SESSION_HEADER));
  return sandboxId
    ? { kind: "agent", id: `assistant:${sandboxId}`, role: "agent", sandboxId }
    : { kind: "agent", id: "mcp:external", role: "agent", sandboxId: EXTERNAL_MCP_SANDBOX };
}

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

/**
 * Tells the agent what happened in terms it can act on. A held request is not
 * an error: the agent should report it to the user and move on, not retry.
 */
function toToolResult(result: ServiceResult<ActionRequestDTO>) {
  if (!result.ok) {
    return { isError: true, content: text({ error: result.code, message: result.error, details: result.details }) };
  }
  const request = result.data;
  switch (request.status) {
    case "executed":
      return {
        content: text({
          status: "done",
          summary: request.summary,
          result: request.result,
          ...(request.undoUntil
            ? { undo: { until: request.undoUntil, link: linkTo(request.id), message: "Tell the user they can undo this for 10 minutes with this link." } }
            : {}),
        }),
      };
    case "pending":
      return {
        content: text({
          status: "waiting_for_human",
          requestId: request.id,
          summary: request.summary,
          reasons: request.reasons,
          approvalLink: linkTo(request.id),
          message:
            "This needs the user's approval before it runs. Show them the approvalLink (only they can open it and decide). Do not retry; use request_status to check later.",
        }),
      };
    case "denied":
      return { isError: true, content: text({ status: "not_allowed", message: "The owner does not allow the AI to do this." }) };
    default:
      return { isError: true, content: text({ status: request.status, message: request.error ?? "The action did not complete." }) };
  }
}

const mcpHandler = createMcpHandler(
  async (server) => {
    const principal = currentPrincipal();

    // --- TOOLS ---
    // Three generic tools instead of one per action: the tool list stays small
    // however many projects are connected, and people can name a project in
    // their own words ("work on the Addiits website").
    const directory = await projectDirectory(principal);

    server.registerTool(
      "list_projects",
      {
        title: "List connected projects",
        description:
          "List the systems the user has connected to OpsPulse (websites, apps, tools). Call this first when the user mentions a project or asks what you can work on.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({
        content: text(
          directory.map((p) => ({ project: p.slug, name: p.name, description: p.description, actions: p.actions.length })),
        ),
      }),
    );

    server.registerTool(
      "find_actions",
      {
        title: "See what can be done in a project",
        description:
          "Show the actions available in one project, with the owner's rule for each and the input each needs. `project` can be the project's name in the user's words; `query` optionally narrows to matching actions.",
        inputSchema: z.object({ project: z.string().min(1), query: z.string().optional() }),
        annotations: { readOnlyHint: true },
      },
      async ({ project, query }) => {
        const match = matchProject(directory, project);
        if (!match.found) return { isError: true, content: text(match) };
        const words = (query ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const actions = match.project.actions.filter(
          (a) => words.length === 0 || words.some((w) => `${a.action.name} ${a.action.title} ${a.action.description}`.toLowerCase().includes(w)),
        );
        return {
          content: text({
            project: match.project.slug,
            name: match.project.name,
            actions: (actions.length ? actions : match.project.actions).map((a) => ({
              action: a.action.name,
              title: a.action.title,
              description: a.action.description,
              rule: TIER_LABEL[a.tier],
              input: a.action.input,
            })),
          }),
        };
      },
    );

    server.registerTool(
      "run_action",
      {
        title: "Do something in a project",
        description:
          "Run one action in a project, following the owner's rules: it may run now, run with a 10-minute undo, wait for the owner's approval, or be refused. Use find_actions first to get the action name and input.",
        inputSchema: z.object({
          project: z.string().min(1),
          action: z.string().min(1),
          input: z.record(z.string(), z.unknown()).default({}),
        }),
      },
      async ({ project, action, input }) => {
        const match = matchProject(directory, project);
        if (!match.found) return { isError: true, content: text(match) };
        return toToolResult(await invokeAction(principal, match.project.id, action, input));
      },
    );

    server.registerTool(
      "request_status",
      {
        title: "Check a held request",
        description: "Check whether a request that was waiting for a human has been approved, declined or run.",
        inputSchema: z.object({ requestId: z.string().uuid() }),
        annotations: { readOnlyHint: true },
      },
      async ({ requestId }) => {
        const result = await getRequest(principal, requestId);
        if (!result.ok) return { isError: true, content: text({ error: result.code, message: result.error }) };
        const { status, summary, result: output, error } = result.data;
        return { content: text({ status, summary, result: output, error }) };
      },
    );

    // --- RESOURCES ---
    server.registerResource(
      "system-schema",
      "system://schema",
      {
        title: "System Database Schema",
        description: "Read-only database schema and operational rules for OpsPulse.",
        mimeType: "text/plain",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: [
              "OpsPulse Database Schema:",
              "- tickets(id, sandbox_id, title, description, priority[LOW|MEDIUM|HIGH], status[OPEN|IN_PROGRESS|RESOLVED], created_at, expires_at)",
              "- deletion_requests(id, sandbox_id, ticket_id, reason, status[PENDING|APPROVED|REJECTED])",
              "- audit_logs(id, sandbox_id, action, input_payload, output_payload, latency_ms, is_error, created_at)",
              "Gateway rules:",
              "- Tools are named <project>__<action>. Each has an owner-set rule: run automatically, run with a 10-minute undo, ask a human first, or never.",
              "- A held request returns status waiting_for_human; only a human can approve it in the dashboard.",
              "- Tickets expire after 24h.",
            ].join("\n"),
          },
        ],
      }),
    );

    server.registerResource(
      "system-audit-logs",
      "system://audit-logs",
      {
        title: "System Audit Logs",
        description: "Recent audit log entries for the current workspace.",
        mimeType: "application/json",
      },
      async (uri) => {
        const result = await getRecentAuditLogs(currentPrincipal(), 20);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(result.ok ? result.data : { error: result.error }, null, 2),
            },
          ],
        };
      },
    );

    // --- PROMPTS ---
    server.registerPrompt(
      "incident_summary_prompt",
      {
        title: "Incident Summary Report",
        description: "Generate an executive incident summary report from current workspace tickets.",
      },
      async () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "First call tickets__list_tickets to fetch all active incidents. Then summarize them grouped by priority (HIGH, MEDIUM, LOW) with clear action items for the on-call engineer.",
            },
          },
        ],
      }),
    );
  },
  {},
);

export const maxDuration = 60;

async function handleSecuredMcp(req: NextRequest) {
  if (!isAllowedOrigin(req.headers.get("origin"))) {
    return NextResponse.json({ error: "Forbidden origin", code: "FORBIDDEN" }, { status: 403 });
  }
  const principal = await authenticate(req);
  if (!principal) {
    // Points OAuth-capable clients (claude.ai, ChatGPT) at the login flow.
    const origin = internalBaseUrl(req.headers.get("host"));
    return NextResponse.json(
      { error: "Sign in required", code: "UNAUTHENTICATED" },
      {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
      },
    );
  }
  const origin = internalBaseUrl(req.headers.get("host"));
  return originStorage.run(origin, () => principalStorage.run(principal, () => mcpHandler(req)));
}

/**
 * Two ways in, both as an `agent`:
 * - an OAuth access token from an app the user allowed → that user's workspace;
 * - the server key (in-app assistant, developer tools) → as before.
 */
async function authenticate(req: NextRequest): Promise<Principal | null> {
  const authorization = req.headers.get("authorization");
  if (hasBearer(authorization, getEnv().MCP_API_KEY)) return resolveAgentPrincipal(req);
  if (!authorization?.startsWith("Bearer ")) return null;
  const grant = await verifyAccessToken(authorization.slice(7).trim());
  if (!grant) return null;
  const user = await getUser(grant.userId);
  return user ? { kind: "agent", id: `app:${grant.clientId}`, role: "agent", sandboxId: user.workspaceId } : null;
}

export { handleSecuredMcp as GET, handleSecuredMcp as POST, handleSecuredMcp as DELETE };
