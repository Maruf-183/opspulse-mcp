import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest, NextResponse } from "next/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type { Principal } from "@/lib/authz/policy";
import { getEnv } from "@/lib/env";
import { hasBearer } from "@/lib/security/crypto";
import { isAllowedOrigin } from "@/lib/security/origins";
import { SESSION_HEADER, verifySessionToken } from "@/lib/security/session";
import type { ServiceResult } from "@/services/result";
import {
  createTicket,
  getRecentAuditLogs,
  listTickets,
  requestTicketDeletion,
  updateTicket,
} from "@/services/ticket.service";

/** Sandbox shared by external MCP clients (Cursor, Claude Desktop, …). */
const EXTERNAL_MCP_SANDBOX = "demo-sandbox";

/**
 * The principal is resolved once, in the route wrapper, from verified inputs
 * only, and carried to tool handlers through AsyncLocalStorage. Tool handlers
 * never read identity from headers themselves.
 */
const principalStorage = new AsyncLocalStorage<Principal>();

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

function toToolResult<T>(result: ServiceResult<T>) {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${result.code}: ${result.error}` }],
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
}

const mcpHandler = createMcpHandler(
  (server) => {
    // --- TOOLS ---
    server.registerTool(
      "create_ticket",
      {
        title: "Create Ticket",
        description: "Create a new operational incident or task ticket in the current workspace.",
        inputSchema: z.object({
          title: z.string().describe("Short title of the incident or task (3-120 chars)"),
          description: z.string().describe("Detailed description of the issue (5-1000 chars)"),
          priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async (args) => toToolResult(await createTicket(currentPrincipal(), args)),
    );

    server.registerTool(
      "list_tickets",
      {
        title: "List Tickets",
        description: "List active tickets in the current workspace with optional status or priority filters.",
        inputSchema: z.object({
          status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]).optional(),
          priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async (args) => toToolResult(await listTickets(currentPrincipal(), args)),
    );

    server.registerTool(
      "update_ticket",
      {
        title: "Update Ticket",
        description: "Change a ticket's status and/or priority. At least one field is required.",
        inputSchema: z.object({
          ticketId: z.number().int().positive().describe("Numeric ID of the ticket"),
          status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]).optional(),
          priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ ticketId, ...changes }) =>
        toToolResult(await updateTicket(currentPrincipal(), ticketId, changes)),
    );

    server.registerTool(
      "request_ticket_deletion",
      {
        title: "Request Ticket Deletion",
        description:
          "Request deletion of a ticket by ID. Creates a PENDING approval that a human must approve; never deletes immediately.",
        inputSchema: z.object({
          ticketId: z.number().int().positive().describe("Numeric ID of the ticket to delete"),
          reason: z.string().describe("Reason why this ticket should be deleted"),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async (args) => toToolResult(await requestTicketDeletion(currentPrincipal(), args)),
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
              "Permission rules:",
              "- MCP clients act as role 'agent': read, create, update, request deletion.",
              "- Approving a deletion requires a human operator; agents can never approve.",
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
              text: "First call list_tickets to fetch all active incidents. Then summarize them grouped by priority (HIGH, MEDIUM, LOW) with clear action items for the on-call engineer.",
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
  if (!hasBearer(req.headers.get("authorization"), getEnv().MCP_API_KEY)) {
    return NextResponse.json(
      { error: "Invalid or missing Bearer token", code: "UNAUTHENTICATED" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  const principal = resolveAgentPrincipal(req);
  return principalStorage.run(principal, () => mcpHandler(req));
}

export { handleSecuredMcp as GET, handleSecuredMcp as POST, handleSecuredMcp as DELETE };
