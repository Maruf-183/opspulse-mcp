# ADR 002: Central authorization layer between API and database

- **Status:** Accepted
- **Date:** 2026-11-18

## Context

OpsPulse is reached through three entry points — the dashboard, a REST API, and an MCP server used by AI agents. Before this change, access control was implicit:

- the sandbox ID came from an unsigned cookie or a caller-supplied `x-sandbox-id` header, so any caller with the MCP key could address any sandbox;
- browsers without a cookie fell back to a shared `demo-sandbox`, where anyone could approve pending deletions;
- "human approval" meant "whoever can call the approval route", so it was a confirmation step rather than a permission.

## Decision

1. Introduce a **Principal** (`kind: human | agent`, `role`, `sandboxId`) resolved once per request from *verified* inputs only (signed session cookie, signed session header, bearer key).
2. Define permissions and a role → permission map in one module (`src/lib/authz/policy.ts`), with a hard rule that `ticket:delete:approve` is human-only.
3. Enforce permissions **in the service layer**, not in routes, so the dashboard, REST and MCP paths cannot drift apart. Denials are audited.
4. Replace the unsigned sandbox cookie with an HMAC-signed one and remove the browser fallback sandbox.

## Consequences

- Adding real user accounts (Auth.js, Clerk, …) only changes Principal resolution in `src/lib/http.ts` and the MCP route: map the session to `{ kind: "human", role, sandboxId: orgId }`. Services and policy are unchanged.
- Existing unsigned cookies are treated as missing; visitors receive a new workspace on their next load. Demo data is short-lived, so no migration is needed.
- No database schema changes were required. A future migration should add a `requested_by` column to `deletion_requests` to enforce "approver ≠ requester" between two humans; today the actor is recorded in the audit log.
- External MCP clients remain confined to `demo-sandbox` until per-user MCP tokens or OAuth are added.

## Alternatives considered

- **Checks in each route:** simpler, but three entry points would need to stay in sync by hand.
- **Postgres Row-Level Security:** a good defence-in-depth addition once there are real tenants; it does not replace application-level permissions such as "agents cannot approve".
- **A policy library (CASL, Cerbos):** reasonable once rules become attribute-based; the current rule set is small enough for a typed map.
