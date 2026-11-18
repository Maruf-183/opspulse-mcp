# Security Notes

## Authorization layer

Every request is resolved to a **Principal** before it reaches the service layer, and every service function checks a **permission** before it touches the database. Routes never make permission decisions themselves.

```
Dashboard / REST ─┐
                  ├─► resolve Principal ─► authorize(permission) ─► service ─► Postgres
MCP (AI agents) ──┘        (who?)              (allowed?)          (scoped by sandboxId)
```

| Role       | Who                         | Permissions                                                             |
| ---------- | --------------------------- | ----------------------------------------------------------------------- |
| `viewer`   | read-only humans            | `ticket:read`, `audit:read`                                             |
| `agent`    | the in-app AI, MCP clients  | `ticket:read`, `ticket:create`, `ticket:update`, `ticket:delete:request`, `audit:read` |
| `operator` | the human owning a workspace | all of the above + `ticket:delete:approve`                              |
| `admin`    | reserved                    | everything                                                              |

`ticket:delete:approve` is additionally **human-only**: `can()` refuses it for any `agent` principal regardless of role, so a misconfigured role map cannot give an AI the ability to approve its own request. Denied attempts are written to the audit log.

The policy lives in `src/lib/authz/policy.ts`; enforcement lives in `src/services/ticket.service.ts`.

## Identity and sandbox isolation

- **Browser:** `GET /api/state` issues an HttpOnly, SameSite=Lax, `Secure` (in production) cookie containing `sbx_<96-bit id>.<HMAC-SHA256 signature>`. All other browser routes require a correctly signed cookie and return `401` otherwise. A client cannot forge or guess another sandbox, and there is no shared fallback sandbox for browsers.
- **In-app assistant:** `/api/chat` forwards the *signed* session to the MCP endpoint in `x-opspulse-session`. The MCP server verifies the signature and acts as an `agent` principal in that sandbox.
- **External MCP clients:** callers with the bearer key but no signed session act as an `agent` in the shared `demo-sandbox`.
- Signing key: `SESSION_SECRET`, or a key derived from `MCP_API_KEY` if unset. Rotating it invalidates all sessions.

This is still **workspace isolation, not user authentication**: anyone who loads the dashboard gets their own operator workspace. Adding real accounts only changes Principal resolution (see ADR 002).

## Request hardening

- **Origin checks** use exact origin matching against hosts derived from configuration (`APP_URL`, Vercel URL variables, and `localhost` outside production). Substring matches such as `opspulse-work.vercel.app.evil.com` are rejected. Browser writes (`POST`/`PATCH`/`DELETE`) also require an allowed Origin.
- **Internal MCP URL**: the chat route only trusts the `Host` header if it is one of the deployment's own hosts, so a forged Host cannot redirect the server's bearer token elsewhere.
- **Bearer and cron secrets** are compared in constant time.
- **Chat history** from the browser is reduced to `user`/`assistant` text parts. Client-supplied `system` messages and tool-call/tool-result parts are dropped so they cannot inject instructions or forge tool output.
- **Error responses** use a uniform `{ error, code, details? }` body and do not leak provider or database error text.

## Human-in-the-loop deletion

1. An agent (or the dashboard's delete button) calls `request_ticket_deletion` / `DELETE /api/tickets/:id`. This only creates a `PENDING` request; repeated requests for the same ticket return the existing one.
2. A human calls `POST /api/approvals/:id`. In a single database transaction the ticket is deleted, the request is claimed (`WHERE status = 'PENDING'`), and duplicate pending requests for that ticket are rejected. Concurrent approve/reject clicks cannot both succeed.
3. Approvals and rejections are both audited, with the acting principal recorded.

## Prompt injection

Ticket content is untrusted. The system prompt tells the model to treat it as data, and the permission layer means that even a successfully injected model cannot approve a deletion or leave its sandbox.

## Rate limiting and circuit breaker

Counters live in `rate_limits` and are incremented with a single atomic `INSERT … ON CONFLICT DO UPDATE` per key.

- Per-IP: 12 chat requests per minute (checked first, using `x-real-ip` set by Vercel).
- Global: 250 chat requests per UTC day. Requests already blocked per-IP do not consume this quota.

## Operational guidance

- `CRON_SECRET` is **required in production**; without it the cleanup route refuses to run.
- Set `SESSION_SECRET` explicitly in production so rotating `MCP_API_KEY` does not also log everyone out.
- Do not enter personal or sensitive data in this demo.
