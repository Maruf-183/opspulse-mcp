# OpsPulse MCP: Senior Engineering Interview Questions

## 1. How does a chat request reach a database tool?

`POST /api/chat` validates the UI message history, applies the database-backed rate limiter, reads the sandbox cookie, and creates an authenticated HTTP MCP client. The AI SDK exposes MCP tools to the model. A tool call reaches `/api/mcp/mcp`, where the handler resolves the sandbox and calls a function in `src/services/`; Drizzle persists the change in Neon Postgres.

## 2. Why use MCP over directly calling ticket functions from the model route?

MCP provides a protocol boundary for tools, resources, and prompts. It keeps operations discoverable and usable by MCP-compatible clients, while the ticket service remains the shared business-logic/data-access layer.

## 3. How is tenant isolation implemented, and what are its limits?

The browser gets an HttpOnly `opspulse_sandbox` cookie. State and service queries filter by `sandboxId`; chat forwards that identifier as `x-sandbox-id` to MCP, and the MCP request context makes it available to tool handlers. This separates demo workspaces but does not authenticate people; there is no user identity or per-user ACL.

## 4. Why is AI SDK approval metadata insufficient for destructive actions?

Client-side or SDK approval UX can be bypassed. A destructive mutation must be denied by default at the server boundary. Here the tool only creates a pending deletion request; a separate server endpoint validates that request and sandbox before deleting.

## 5. What prevents a ticket description from changing the assistant's behavior?

The system prompt labels returned ticket content as untrusted and instructs the model to ignore embedded instructions. The design also scopes tools to the sandbox and validates their inputs. Prompt instructions reduce the risk but cannot guarantee the model will never be influenced, so server controls remain authoritative.

## 6. Explain the rate limiter and global circuit breaker.

The `rate_limits` table stores per-IP minute counters and a global UTC-day counter. Chat permits up to 12 requests per IP per minute and 250 total per UTC day. The global threshold returns a read-only-style response until the next day; the counters are persisted rather than process-local.

## 7. What consistency and concurrency concerns exist in the rate-limit implementation?

The current check, increment, and insert are separate operations, so concurrent requests can race near a threshold. A high-traffic deployment should use an atomic upsert/increment or transaction with a suitable isolation strategy, and likely move abuse controls closer to the edge.

## 8. Why does the dashboard refresh after tool completion and chat completion?

The tool performs its database write in a separate HTTP request. A chat stream finishing is not itself proof that the browser's workspace data has been refreshed. Refreshing on tool output makes writes visible promptly, while the final chat callback catches any changes completed later in the same assistant turn.

## 9. What does the daily cleanup job remove, and how is it protected?

Vercel calls `/api/cron/cleanup` daily at 03:00 UTC. The route removes expired tickets and audit, deletion-request, and rate-limit rows older than 24 hours. If `CRON_SECRET` is configured, it requires the matching bearer header; production should configure the secret.

## 10. What would you change before calling this a multi-user production service?

Add user authentication and per-user authorization, bind sandboxes to authenticated identities, use per-user MCP credentials or OAuth, make rate limiting atomic and resilient, review the data retention/audit policy, add monitoring/alerts and migrations, and define recovery behavior for provider/database outages. The current demo has no user accounts and refreshes state rather than using WebSockets.
