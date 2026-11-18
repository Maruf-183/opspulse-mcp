# OpsPulse MCP

OpsPulse MCP is a full-stack AI operations dashboard for managing short-lived incident tickets through an assistant and a Model Context Protocol (MCP) server. It demonstrates Streamable HTTP tool calls, sandbox-scoped state, server-enforced human approval for deletions, and live audit history.

> **Live demo:** https://opspulse-work.vercel.app/

Do not enter sensitive or personal data. This demo does not provide user accounts and automatically expires tickets after 24 hours.

## Highlights

- Two-panel operations assistant and live workspace dashboard.
- **Central authorization layer**: every request becomes a Principal (human or AI agent) with a role; services check permissions before any database access. AI agents can never approve deletions.
- REST API for tickets, approvals and audit logs, sharing the same service layer as the MCP tools.
- MCP tools for creating, listing and updating tickets, and requesting deletion.
- MCP resource for the system schema and an incident-summary prompt.
- Server-side HITL: AI requests deletion; a human must approve it.
- Sandbox-scoped tickets, pending approvals, and audit logs in Neon Postgres.
- Daily Vercel Cron cleanup for expired and aged records.
- Rate limiting and a global daily AI circuit breaker.

## Tech stack

- Next.js App Router, React, TypeScript, and Tailwind CSS
- Vercel AI SDK with Google Generative AI
- MCP Streamable HTTP via `mcp-handler` and `@ai-sdk/mcp`
- Neon Serverless Postgres and Drizzle ORM
- Vitest and ESLint; GitHub Actions CI on Node.js 22

## Local setup

### Requirements

- Node.js 22
- npm
- A Neon Postgres database (or another compatible PostgreSQL URL)
- Google Generative AI API key

### Install and configure

```bash
npm ci
```

Copy `.env.example` to `.env.local` and set:

```dotenv
DATABASE_URL=postgresql://...
MCP_API_KEY=replace-with-a-long-random-secret
GOOGLE_GENERATIVE_AI_API_KEY=your-google-api-key
GEMINI_MODEL=gemini-2.5-flash
CRON_SECRET=replace-with-a-long-random-secret
SESSION_SECRET=at-least-32-random-characters   # optional, recommended
APP_URL=http://localhost:3000                    # optional
```

`CRON_SECRET` is optional locally and **required in production** (the cleanup route refuses to run without it). `SESSION_SECRET` signs workspace cookies; if unset, a key is derived from `MCP_API_KEY`. Keep all secrets server-side and out of version control.

Create/update the database schema and optionally seed demo data:

```bash
npm run db:push
npm run db:seed
```

Run the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same checks for pushes and pull requests targeting `main`. The CI build uses dummy database and MCP values; it does not connect to a real database or call the model provider.

## MCP client configuration

Deploy the app to Vercel, configure `MCP_API_KEY` in the deployment environment, and replace the example host and key below. The MCP endpoint is:

```text
https://opspulse-work.vercel.app/api/mcp/mcp
```

The endpoint requires `Authorization: Bearer <MCP_API_KEY>`. Keep the credential private. External MCP clients act with the `agent` role inside the shared `demo-sandbox`: they can read, create, update and *request* deletion, but cannot approve it. The MCP key is shared and does not identify an individual user.

Reviewers and interviewers can request the demo Bearer token for live verification, or generate their own `MCP_API_KEY` using the local setup above. `YOUR_MCP_API_KEY` is intentionally kept as a placeholder in this public README and should never be replaced with a real secret in committed files.

### Quick Verification for Reviewers

- **Tools:** `create_ticket`, `list_tickets`, `update_ticket`, `request_ticket_deletion`
- **Resources:** `system://schema`, `system://audit-logs`
- **Prompt:** `incident_summary_prompt`

Use the live endpoint below with the Bearer token to verify these MCP capabilities.

### Cursor

Add this to Cursor's MCP server configuration (for example, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "opspulse": {
      "url": "https://opspulse-work.vercel.app/api/mcp/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

### Claude Desktop

Claude Desktop's local server configuration can run the `mcp-remote` bridge to connect to the remote Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "opspulse": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://opspulse-work.vercel.app/api/mcp/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_API_KEY"
      ]
    }
  }
}
```

Replace `YOUR_MCP_API_KEY` with the deployed secret. Avoid committing client configuration containing a real credential. For shared or multi-user use, use a supported secret-management mechanism rather than a checked-in plaintext key.

## REST API

All browser routes use the signed workspace cookie issued by `GET /api/state`. Responses are `{ data }` on success and `{ error, code, details? }` on failure.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/me` | current principal and permissions |
| `GET` / `POST` | `/api/tickets` | `ticket:read` / `ticket:create` |
| `GET` / `PATCH` | `/api/tickets/:id` | `ticket:read` / `ticket:update` |
| `DELETE` | `/api/tickets/:id` | `ticket:delete:request` → `202`, pending approval |
| `GET` | `/api/approvals` | `ticket:read` |
| `POST` | `/api/approvals/:id` | `ticket:delete:approve` (humans only) |
| `GET` | `/api/audit-logs` | `audit:read` |

## Security highlights

- **Authorization layer** (`src/lib/authz/policy.ts`): roles `viewer`, `agent`, `operator`, `admin`; permissions are enforced in the service layer for every entry point, and denials are audited.
- **Signed workspace sessions**: the `opspulse_sandbox` cookie is HMAC-signed, so a client cannot switch to another sandbox. There is no shared fallback for browsers.
- **Server-enforced HITL**: agents can only request deletion; approval is human-only and runs in a single transaction that is safe against double clicks.
- Exact-match origin checks, constant-time secret comparison, and a Host allow-list for the internal MCP call.
- Browser chat history is reduced to user/assistant text, so clients cannot inject system prompts or forge tool results.
- Atomic per-IP rate limiting (checked first) and a global daily circuit breaker.

See [docs/security.md](./docs/security.md) and [docs/adr-001-security-and-hitl.md](./docs/adr-001-security-and-hitl.md) for details.

## Honest limitations

- There are **no user accounts** yet: each visitor is the operator of their own signed workspace. The authorization layer is designed so accounts plug in by changing Principal resolution only (see ADR 002).
- MCP uses a shared bearer secret, not full OAuth.
- Workspace updates use refreshes after chat/tool activity, not WebSockets or a live subscription.
- Rate limiting is database-backed and atomic per key; consider an edge rate limiter for high traffic.
- Model-provider quotas and database availability can make AI operations unavailable.
- Audit and sandbox data is short-lived; this is not a compliance-grade immutable audit system.

## Architecture and design notes

- [Architecture and sequence diagram](./docs/architecture.md)
- [ADR 001: Security and HITL](./docs/adr-001-security-and-hitl.md)
- [ADR 002: Authorization layer](./docs/adr-002-authorization-layer.md)
- [Security model and operational notes](./docs/security.md)
- [Senior engineering interview questions](./INTERVIEW.md)
