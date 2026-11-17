# Security Notes

## Sandbox isolation

The application issues an HttpOnly, SameSite=Lax `opspulse_sandbox` cookie with a 24-hour lifetime. `/api/state` reads this cookie and queries tickets, pending deletion requests, and audit logs by `sandboxId`. Chat forwards the same sandbox identifier to the MCP handler using `x-sandbox-id`; the MCP route binds it to the request context and tools pass it into service/database queries.

This is **workspace isolation, not authentication**. A sandbox cookie does not prove a user's identity, and a shared bearer key does not provide per-user access control. Requests without a browser cookie fall back to the demo sandbox for current API paths. Do not treat demo data as private or store sensitive information.

## Prompt injection and untrusted ticket content

Ticket titles, descriptions, and other database content are untrusted data. The system prompt instructs the assistant to ignore instruction-like content embedded in tickets. When asked to inspect or summarize tickets, the assistant is instructed to fetch live records first. This reduces prompt-injection risk but is not a complete isolation boundary: model behavior is probabilistic. Tool schemas, server-side sandbox scoping, input validation, and server-enforced approval remain essential.

## Rate limiting and circuit breaker

`checkRateLimitAndCircuitBreaker` persists counters in the `rate_limits` table:

- Per-IP limit: 12 chat requests per minute.
- Global demo quota: 250 chat requests per UTC day. When reached, chat returns a read-only/circuit-breaker response until the next UTC day.

These are application-level controls backed by the configured database. They are not a substitute for edge-level abuse prevention, and database availability/atomicity should be considered when scaling concurrent traffic.

## MCP access

The MCP route checks the `Authorization: Bearer <MCP_API_KEY>` header and validates the request origin when an Origin header is present. Keep `MCP_API_KEY` in server environment settings; do not commit it, put it in browser code, or expose it in public configuration. The key is shared by the current application integration, not OAuth or a per-user token.

## Human-in-the-loop deletion

The MCP deletion tool only creates a sandbox-scoped pending request. It cannot delete a ticket. The server-side approval endpoint verifies a pending request and matches it to the cookie's sandbox before executing the deletion. User confirmation in the UI is required to reach that endpoint.

## Operational guidance

- Set `CRON_SECRET` in production to protect scheduled cleanup invocations.
- Set distinct, strong secrets in each environment and rotate them if exposed.
- Do not enter personal or sensitive data in this free-tier demo.
- Add user authentication, per-user authorization, stronger audit retention, and production-grade rate limiting before making this a multi-user service.
