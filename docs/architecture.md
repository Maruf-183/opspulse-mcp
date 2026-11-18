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
    Chat->>Client: Create client with Bearer token + signed session
    Chat->>AI: Stream model response with MCP tools
    AI->>Client: Invoke create_ticket / list_tickets / request_ticket_deletion
    Client->>MCP: Streamable HTTP request + auth and sandbox headers
    MCP->>MCP: Verify origin/token, resolve agent Principal from signed session
    MCP->>Services: Execute tool as agent Principal (permission checked)
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
        Approval->>Services: Human Principal; check ticket:delete:approve
        Services->>DB: One transaction: delete ticket, claim request, close duplicates; audit
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

1. `GET /api/state` issues a signed `opspulse_sandbox` cookie if needed and returns only data for that sandbox. Every other browser route requires a valid signed cookie.
2. Each request is resolved to a **Principal** (`src/lib/authz/policy.ts`): the dashboard user is a human `operator`; every MCP caller is an `agent`.
3. The browser sends the conversation to `POST /api/chat`. The route keeps only user/assistant text, enforces limits, and creates an HTTP MCP client that forwards the signed session.
4. MCP tool calls reach `/api/mcp/mcp`. The route verifies the bearer key, resolves the agent Principal, and binds it to the request with `AsyncLocalStorage`.
5. Every entry point — REST routes, MCP tools, the dashboard — calls the same functions in `src/services/`, which check permissions and scope every query by `sandboxId`.
6. Destructive requests create pending records; only a human Principal can approve them.

## API surface

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/state` | dashboard snapshot (issues session) |
| `GET` | `/api/me` | current principal and permissions |
| `GET` / `POST` | `/api/tickets` | `ticket:read` / `ticket:create` |
| `GET` / `PATCH` | `/api/tickets/:id` | `ticket:read` / `ticket:update` |
| `DELETE` | `/api/tickets/:id` | `ticket:delete:request` (returns 202, pending) |
| `GET` | `/api/approvals` | `ticket:read` |
| `POST` | `/api/approvals/:id` | `ticket:delete:approve` (human only) |
| `GET` | `/api/audit-logs` | `audit:read` |
| `POST` | `/api/chat` | signed session + rate limit |
| `GET`/`POST`/`DELETE` | `/api/mcp/mcp` | bearer key; acts as `agent` |
| `GET` | `/api/health` | public |
| `GET` | `/api/cron/cleanup` | `CRON_SECRET` |

## Scheduled maintenance

Vercel runs `GET /api/cron/cleanup` daily at 03:00 UTC. It deletes expired tickets and audit logs, deletion requests, and rate-limit rows older than 24 hours. Configure `CRON_SECRET` in deployment settings so the route requires `Authorization: Bearer <CRON_SECRET>`.

## Important boundaries

- The signed sandbox cookie isolates browser workspaces; it is not user authentication. See ADR 002 for how accounts plug in.
- MCP access uses a shared scoped bearer secret, not per-user OAuth.
- The chat and MCP handlers are HTTP request/response streams; the dashboard refreshes state after activity rather than subscribing to WebSockets.
- External AI and database availability, provider quotas, and configured rate limits affect request success.
