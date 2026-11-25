# OpsPulse

**A permission layer between AI assistants and the systems they work on.**

Connect OpsPulse to Claude (or ChatGPT, Cursor, Claude Code), connect your systems to OpsPulse, then just talk to the AI. Every action it takes goes through rules the owner chose:

| Rule | What happens |
| --- | --- |
| **Run automatically** | Runs now. |
| **Run, can undo** | Runs now; the owner can reverse it for 10 minutes. |
| **Ask me first** | Held until a person approves the exact change shown to them. |
| **Never allow** | Refused; the AI doesn't even see the action. |

> Live: https://opspulse-work.vercel.app · MCP endpoint: `https://opspulse-work.vercel.app/api/mcp/mcp`

## Why it exists

AI agents can now change real systems: send email, refund orders, publish posts, edit records. Existing gateways (Permit.io, TrueFoundry, Kong, HumanLayer) can *stop* a call and ask, but two problems remain:

- **Approval fatigue.** When everything asks, people approve without reading. OpsPulse asks less: reversible actions run with an undo window instead, and simple, explainable rules escalate only the unusual (bulk changes, first-time actions, quiet hours).
- **Approvals people can't judge.** Approvers are often business owners, not engineers. OpsPulse shows a plain-language summary, a before/after preview and the consequences ("৳12,800 will be refunded; refunds can't be reversed"), and **runs exactly what was approved**: if the change differs at approval time, it is refused.

## How people use it

1. In Claude: **Settings → Connectors → Add custom connector**, paste the MCP endpoint, sign in with GitHub, press **Allow**.
2. Talk normally: *"Show me the new leads on the Addiits site and move the good ones to in-progress."*
3. When something needs approval, the AI shows a link. One tap: **Allow** or **Decline**. Undo links work the same way.

No dashboard is required. One exists at `/dashboard` for people who want to see everything, change rules and connect systems.

## Connect any system

| System has… | Connect with | Code needed |
| --- | --- | --- |
| An MCP server (GitHub, Notion, Slack, …) | Its URL (+ access key) | None |
| A Postgres or MySQL database | Its connection URL | None |
| An OpenAPI 3 description | API base URL + description URL | None |
| Only an HTTP API you control | Manifest + a signature check | ~15 lines ([Node](packages/connect-node), [Python](docs/connect/python.md), [PHP](docs/connect/php.md)) |

Each connection discovers what the system can do and applies safe defaults (read = automatic, write = ask, delete = never). See [examples/demo-store](examples/demo-store) for a complete HTTP integration.

## Architecture

```
AI app ──MCP──► /api/mcp ──► Principal ──► Gateway pipeline ─────────────► Connector ──► System
(Claude …)      OAuth 2.1     (who?)        validate input                   builtin | http |
                or server key                decide tier (rules.ts)           mcp | openapi |
                                             ├ never → deny                   database
                                             ├ auto  → run
                                             ├ undo  → run + keep undo token
                                             └ ask   → preview → hold → human approves
                                                        → re-check → run exactly once
                                             every step → hash-chained activity log
```

- `src/gateway/` — contract (`types.ts`), tier engine (`rules.ts`), pipeline (`service.ts`), tamper-evident log (`events.ts`), connectors.
- `src/lib/authz/` — roles and permissions; AI agents can never approve or change rules.
- `src/lib/auth/` — GitHub sign-in and the OAuth 2.1 authorization server used by AI apps.
- `src/app/r/[id]` — the one-page approve/decline/undo screen linked from chat.

Design decisions: [ADR 002 — authorization layer](docs/adr-002-authorization-layer.md), [ADR 003 — gateway](docs/adr-003-gateway.md). Security: [threat model](docs/threat-model.md). Wire protocol: [gateway contract](docs/gateway-contract.md).

## Engineering notes

- **Exactly once.** Every state change is a conditional update (`WHERE status = 'pending'`); concurrent clicks, retries and races cannot run an action twice. Projects also receive an idempotency key.
- **What you approve is what runs.** Input and preview are hashed at request time and re-checked at approval.
- **Undo.** Connectors return an undo token (encrypted at rest). The database connector snapshots affected rows so inserts, updates and deletes are all reversible.
- **Tamper-evident log.** Each activity event hashes the previous one; a unique `(workspace, prev_hash)` index prevents forks.
- **OAuth 2.1 for AI apps.** Discovery (RFC 9728/8414), dynamic registration (RFC 7591), PKCE S256 only, 1-hour access tokens, rotating refresh tokens with reuse detection, tokens stored only as hashes.
- **No raw SQL from the AI.** Table and column names are checked against the live schema; values are bound parameters; secret columns are never returned.
- **Signed calls to projects.** HMAC over timestamp, request id, method, path and body; 5-minute replay window.

## Run locally

```bash
npm ci
cp .env.example .env.local   # DATABASE_URL, MCP_API_KEY, GEMINI_MODEL, GOOGLE_GENERATIVE_AI_API_KEY, SESSION_SECRET, GITHUB_CLIENT_ID/SECRET
npx drizzle-kit migrate      # or: npm run db:push
npm run dev
```

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Tests run against a real in-process Postgres (PGlite) using the production migrations: the full approval pipeline, OAuth flows, connectors (HTTP, MCP, OpenAPI, database) and security checks.

## Limitations

- Sign-in is GitHub only for now.
- Approvals arrive in chat (link) or on the dashboard; email/push notifications are not built yet.
- Systems reachable only on a private network need a public endpoint or a tunnel.
- External MCP and OpenAPI actions can't be previewed or undone unless the system supports it; they default to *Ask me first*.
