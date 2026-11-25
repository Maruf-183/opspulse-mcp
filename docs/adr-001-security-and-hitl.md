# ADR 001: Scoped MCP bearer token and server-enforced human approval

> **Status: superseded** by [ADR 003](adr-003-gateway.md). The ticket-specific deletion flow described here was replaced by the general approval pipeline; the core idea (the model alone can never authorize a destructive action) carries over.

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

OpsPulse exposes MCP tools that can create and inspect operational tickets and request destructive actions. The demo needs a small, deployable authentication boundary and must ensure model output alone cannot authorize permanent deletion.

## Decision

### Scoped bearer token instead of full OAuth

The MCP HTTP endpoint is protected by a server-side `MCP_API_KEY`, sent as a bearer token by the server-created MCP client. The key is a shared service credential scoped to this application endpoint; it is not a user identity or per-user authorization grant.

For this single-application demo, the shared credential keeps deployment and the MCP integration small. A full OAuth authorization server, consent screens, token lifecycle, and per-user scopes would add significant infrastructure without a user/account model in the product. This choice is appropriate only for the current trusted integration/demo boundary. A multi-user production service should add identity, per-user authorization, credential rotation, and an OAuth-compatible flow before exposing broader access.

### AI SDK approval metadata is not the security boundary

An AI SDK tool's `needsApproval`/approval metadata can drive a useful client interaction, but it does not by itself protect a database operation. A client can be modified or bypassed, and a model can still produce requests. Authorization must be enforced at the server operation that mutates persistent state.

### Server-side deletion request and approval

`request_ticket_deletion` validates the request and verifies that the ticket belongs to the current sandbox. It only creates a `PENDING` deletion request and an audit record. It does not delete the ticket.

The separate `POST /api/approvals/[id]` endpoint executes the action only after the user explicitly chooses Approve in the dashboard. The service verifies the request is still pending and belongs to the sandbox from the HttpOnly cookie before deleting the ticket and marking the request approved. Reject resolves the request without deleting the ticket.

This makes the server-side service and approval route the enforcement points; the UI banner and model text are presentation, not authorization.

## Consequences

- The model has no direct delete tool; it can only request deletion.
- A caller who can access the approval endpoint with the relevant browser sandbox cookie can approve; this is not equivalent to authenticated user identity or an attributable human account.
- The shared MCP bearer token must remain server-side and must be rotated if exposed.
- The current demo sandbox mechanism is isolation, not authentication. Production multi-user deployments require stronger identity and access control.
- Additional database transactions and explicit audit handling may be warranted if stronger consistency or non-repudiation requirements are introduced.

## Alternatives considered

1. **Client-only confirmation or SDK approval metadata:** rejected because clients can be bypassed and the database operation would not have an independent server-side authorization check.
2. **Direct delete tool guarded by a model-generated approval:** rejected because model output cannot establish human intent.
3. **Full OAuth for this demo:** deferred because there are no user accounts or per-user permissions to bind OAuth identities to. Revisit before a broader public production launch.
