import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest, NextResponse } from "next/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  createTicket,
  listTickets,
  requestTicketDeletion,
  getRecentAuditLogs,
} from "@/services/ticket.service";

const sandboxIdStorage = new AsyncLocalStorage<string>();

// ১. Bearer Token যাচাই করার হেল্পার
function verifyAuth(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.MCP_API_KEY;

  if (!expectedToken || !authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7).trim();
  return token === expectedToken;
}

// ২. Origin চেক
function verifyOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("host") || "";
  return origin.includes(host) || origin.includes("localhost");
}

// ৩. Request থেকে Sandbox ID বের করার হেল্পার
function getSandboxId(req: NextRequest) {
  return (
    req.headers.get("x-sandbox-id") ||
    req.cookies.get("opspulse_sandbox")?.value ||
    "demo-sandbox"
  );
}

// ৪. MCP ServerContext থেকে টাইপ-সেফ উপায়ে Sandbox ID বের করা
function getContextHeader(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }

  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  )?.[1];
  if (typeof entry === "string") {
    return entry;
  }
  return Array.isArray(entry) && typeof entry[0] === "string"
    ? entry[0]
    : undefined;
}

function getSandboxIdFromCookie(cookieHeader: string | undefined) {
  const cookie = cookieHeader
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("opspulse_sandbox="));
  if (!cookie) {
    return undefined;
  }

  const value = cookie.slice("opspulse_sandbox=".length);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractSandboxFromContext(extra: unknown): string {
  const context =
    typeof extra === "object" && extra !== null
      ? (extra as { requestInfo?: { headers?: unknown } })
      : undefined;
  const headers = context?.requestInfo?.headers;
  const contextSandboxId =
    getContextHeader(headers, "x-sandbox-id") ??
    getSandboxIdFromCookie(getContextHeader(headers, "cookie"));

  return sandboxIdStorage.getStore() ?? contextSandboxId ?? "demo-sandbox";
}

// ৫. MCP SDK v2 Server হ্যান্ডলার
const mcpHandler = createMcpHandler(
  (server) => {
    // --- PRIMITIVE 1: TOOLS ---
    server.registerTool(
      "create_ticket",
      {
        title: "Create Ticket",
        description: "Create a new operational incident or task ticket in the current sandbox.",
        inputSchema: z.object({
          title: z.string().describe("Short title of the incident or task"),
          description: z.string().describe("Detailed description of the issue"),
          priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      async (args, extra) => {
        const sandboxId = extractSandboxFromContext(extra);
        const result = await createTicket(sandboxId, args);

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.error }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        };
      }
    );

    server.registerTool(
      "list_tickets",
      {
        title: "List Tickets",
        description: "List all tickets in the current sandbox with optional status or priority filters.",
        inputSchema: z.object({
          status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]).optional(),
          priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
      },
      async (args, extra) => {
        const sandboxId = extractSandboxFromContext(extra);
        const result = await listTickets(sandboxId, args);

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.error }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        };
      }
    );

    server.registerTool(
      "request_ticket_deletion",
      {
        title: "Request Ticket Deletion",
        description:
          "Request deletion of a ticket by ID. Creates a PENDING approval request; never deletes immediately.",
        inputSchema: z.object({
          ticketId: z.number().int().positive().describe("Numeric ID of the ticket to delete"),
          reason: z.string().describe("Reason why this ticket should be deleted"),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
        },
      },
      async (args, extra) => {
        const sandboxId = extractSandboxFromContext(extra);
        const result = await requestTicketDeletion(sandboxId, args);

        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: result.error }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        };
      }
    );

    // --- PRIMITIVE 2: RESOURCES ---
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
              "- Security Rule: Tickets expire after 24h. Deletion always requires Human-in-the-Loop approval.",
            ].join("\n"),
          },
        ],
      })
    );

    server.registerResource(
      "system-audit-logs",
      "system://audit-logs",
      {
        title: "System Audit Logs",
        description: "Recent MCP tool execution audit logs for the current sandbox.",
        mimeType: "application/json",
      },
      async (uri, extra) => {
        const sandboxId = extractSandboxFromContext(extra);
        const logs = await getRecentAuditLogs(sandboxId);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(logs, null, 2),
            },
          ],
        };
      }
    );

    // --- PRIMITIVE 3: PROMPTS ---
    server.registerPrompt(
      "incident_summary_prompt",
      {
        title: "Incident Summary Report",
        description: "Generate an executive incident summary report from current sandbox tickets.",
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
      })
    );
  },
  { }
);

export const maxDuration = 60;

// ৬. সুরক্ষিত Route Wrapper
async function handleSecuredMcp(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "Forbidden Origin" }, { status: 403 });
  }
  if (!verifyAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid or missing Bearer token" },
      { status: 401 }
    );
  }

  const sandboxId = getSandboxId(req);
  const headers = new Headers(req.headers);
  headers.set("x-sandbox-id", sandboxId);

  const authedReq = new NextRequest(req.url, {
    method: req.method,
    headers,
    body: req.body,
  });

  return sandboxIdStorage.run(sandboxId, () => mcpHandler(authedReq));
}

export {
  handleSecuredMcp as GET,
  handleSecuredMcp as POST,
  handleSecuredMcp as DELETE,
};
