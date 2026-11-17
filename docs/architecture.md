# OpsPulse MCP Architecture

## System overview

OpsPulse is a Next.js application with a browser dashboard, a stateless HTTP MCP endpoint, AI-powered chat, and a Neon Postgres persistence layer accessed through Drizzle ORM.

```mermaid
sequenceDiagram
    autonumber
    actor Browser
    participant Chat as /api/chat
    participant AI as AI SDK + model
    participant Client as HTTP MCP Client
    participant MCP as /api/mcp/mcp
    participant State as /api/state
    participant Approval as /api/approvals/[id]
    participant Services as services/
    participant DB as Neon Postgres

    Browser->>Chat: POST messages + opspulse_sandbox cookie
    Chat->>Chat: Validate message history and rate limit
    Chat->>Client: Create client with Bearer token + x-sandbox-id
    Chat->>AI: Stream model response with MCP tools
    AI->>Client: Invoke create_ticket / list_tickets / request_ticket_deletion
    Client->>MCP: Streamable HTTP request + auth and sandbox headers
    MCP->>MCP: Verify origin/token and bind sandbox to request context
    MCP->>Services: Execute tool with resolved sandboxId
    Services->>DB: Scoped ticket, approval, and audit queries
    DB-->>Services: Persisted result
    Services-->>MCP: Tool result
    MCP-->>Client: MCP response
    Client-->>AI: Tool result
    AI-->>Chat: Stream assistant output
    Chat-->>Browser: UI message stream
    Browser->>Browser: Refresh GET /api/state after tool completion and chat finish
    Browser->>State: GET /api/state (sandbox cookie)
    State->>DB: Query sandbox tickets, approvals, and audit logs
    DB-->>State: Workspace records
    State-->>Browser: Tickets, pending approvals, and recent audit logs

    rect rgb(35, 45, 65)
        Note over Browser,DB: Human-in-the-loop deletion
        Browser->>Chat: Ask to delete a ticket
        Chat->>Client: Invoke request_ticket_deletion
        Client->>MCP: Authenticated MCP tool request
        MCP->>Services: Validate ticket belongs to sandbox; create PENDING request
        Services->>DB: Insert deletion request and audit event
        DB-->>Services: Persisted pending request
        Services-->>Chat: Pending approval result
        Chat-->>Browser: Assistant explains approval is required
        Browser->>Browser: Render pending approval card
        Browser->>Approval: POST /api/approvals/{id} with approve=true
        Approval->>Services: Verify approval is pending in the same sandbox
        Services->>DB: Delete ticket, resolve request, and write audit event
        DB-->>Approval: Deletion and audit result
        Approval-->>Browser: Approval result
        Browser->>State: Refresh workspace
        State->>DB: Query updated sandbox state
        DB-->>State: Updated records
        State-->>Browser: Updated workspace
    end
```

The final approval request above is sent to the application approval route, not to the MCP endpoint. That route uses the browser's HttpOnly sandbox cookie and invokes the same ticket service.

## Request and data flow

1. `GET /api/state` creates an `opspulse_sandbox` cookie if needed and returns only data associated with that sandbox.
2. The browser sends the conversation to `POST /api/chat`. The route enforces message limits and rate limits, reads the sandbox cookie, and creates the HTTP MCP client.
3. MCP tool calls are sent to `/api/mcp/mcp`. The route verifies the scoped bearer key and resolves the sandbox from the forwarded `x-sandbox-id` header (or cookie).
4. MCP tool/resource handlers call functions in `src/services/`; database operations are scoped by `sandboxId`.
5. Tool operations write audit records. The browser refreshes workspace state after tool completion and after the chat finishes.
6. Destructive requests create pending records; only the approval endpoint can execute the deletion.

## Scheduled maintenance

Vercel runs `GET /api/cron/cleanup` daily at 03:00 UTC. It deletes expired tickets and audit logs, deletion requests, and rate-limit rows older than 24 hours. Configure `CRON_SECRET` in deployment settings so the route requires `Authorization: Bearer <CRON_SECRET>`.

## Important boundaries

- The sandbox cookie isolates browser workspaces; it is not user authentication.
- MCP access uses a shared scoped bearer secret, not per-user OAuth.
- The chat and MCP handlers are HTTP request/response streams; the dashboard refreshes state after activity rather than subscribing to WebSockets.
- External AI and database availability, provider quotas, and configured rate limits affect request success.
