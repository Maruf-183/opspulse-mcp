# Gateway contract (v1)

Source of truth for types: `src/gateway/types.ts`. All dashboard routes use the signed workspace cookie (`withBrowserPrincipal` in `src/lib/http.ts`) and return `{ data }` or `{ error, code, details? }`.

## Dashboard API

| Method | Path | Body | Returns `data` |
| --- | --- | --- | --- |
| `GET` | `/api/overview` | — | `OverviewDTO` |
| `GET` | `/api/projects` | — | `ProjectSummaryDTO[]` |
| `POST` | `/api/projects` | `{ manifest: ProjectManifest }` | `{ project: ProjectDetailDTO, secret?: string }` — `secret` is shown **once** for HTTP projects |
| `GET` | `/api/projects/:id` | — | `ProjectDetailDTO` |
| `DELETE` | `/api/projects/:id` | — | `{ deleted: true }` |
| `PATCH` | `/api/projects/:id/actions/:action` | `{ tier: Tier }` | `ActionPolicyDTO` (`undo` rejected with 400 if unsupported) |
| `GET` | `/api/requests?status=pending` | — | `ActionRequestDTO[]` |
| `GET` | `/api/requests/:id` | — | `ActionRequestDTO` |
| `POST` | `/api/requests/:id/approve` | — | `ActionRequestDTO` (executed or failed) |
| `POST` | `/api/requests/:id/reject` | — | `ActionRequestDTO` |
| `POST` | `/api/requests/:id/undo` | — | `ActionRequestDTO` (status `undone`) |
| `GET` | `/api/activity?limit=50` | — | `ActivityEventDTO[]` |

## MCP exposure

Each action becomes an MCP tool named `<projectSlug>__<action>` whose description starts with the plain-language title and tier. One extra tool, `opspulse__request_status { requestId }`, lets an agent check a held request. A held call returns immediately with `{ status: "pending", requestId, summary }` — the agent never blocks waiting for a human; the gateway executes on approval.

## Invocation pipeline (`invokeAction`)

1. Resolve project + action; validate input against the action's JSON Schema.
2. Authorize principal (`project:invoke`).
3. Effective tier = owner override ?? manifest default; `undo` without connector support → `ask`.
4. Escalation rules may raise the tier (never lower it) and attach reasons.
5. `never` → `denied`. `auto` → execute. `undo` → execute, keep `undoToken` for 10 minutes. `ask` → fetch preview (if supported), store input hash + preview hash, create `pending` request.
6. Approve: atomically claim `pending → approved`, re-check not expired, re-fetch preview and compare hash (changed → `expired` with reason), execute exactly once with the request id as idempotency key.
7. Every transition appends a hash-chained activity event.

## HTTP project protocol

See constants in `types.ts`. OpsPulse calls `action.http` on the project's `baseUrl` with `x-opspulse-mode` set to `execute` or `preview`. Undo is always `POST {baseUrl}/opspulse/undo` with mode `undo` and body `{ action, undoToken }`. The project verifies `x-opspulse-signature`, rejects stale timestamps, and treats `x-opspulse-request-id` as an idempotency key.

- `preview` → `{ changes: [{label, before, after}], warnings: [] }`
- `execute` → `{ result?, undoToken? }`
- errors → non-2xx with `{ error }`
