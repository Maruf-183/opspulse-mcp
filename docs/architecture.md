# Architecture

```
 People ──────────────► Web app (Next.js on Vercel)
   │                     /            landing
   │                     /try         chat with the in-app assistant over sample notes
   │                     /guide       user guide
   │                     /dashboard   approvals, undo, rules, projects, connected apps
   │                     /r/:id       one request: allow / decline / undo
   │                     /login       Google or GitHub
   │
 AI apps (Claude, ChatGPT, Cursor) ──MCP + OAuth 2.1──► /api/mcp/mcp
                                                          │ list_projects · find_actions · run_action · request_status
                                                          ▼
                                     Gateway pipeline (src/gateway/service.ts)
                                       validate → decide rule (rules.ts) → run / hold / refuse
                                       every step → hash-chained activity log (events.ts)
                                                          │
                                     Connectors (src/gateway/connectors/)
                                       builtin · http (signed) · mcp · openapi · database
                                                          │
                                     Your systems ◄───────┘
 Postgres (Neon): users, OAuth clients/tokens, projects, rules, requests, activity, sample notes
```

## Request lifecycle

1. An AI app calls `run_action` with a project (named in the person's own words) and an action.
2. The MCP route authenticates the caller: an OAuth access token maps to the signed-in user's workspace; the server key is used by the in-app assistant.
3. `invokeAction` validates input against the action's schema and decides the rule: owner override or default, then escalation rules that can only make it stricter.
4. **Never** → refused. **Run automatically** → executed. **Run, can undo** → executed and an undo token kept for 10 minutes. **Ask me first** → a preview is fetched, input and preview are hashed, and the request is held. The AI gets a `/r/:id` link to show the person.
5. On approval the request is claimed with a conditional update, the preview is re-checked against its hash, and the action runs exactly once.

## Deployment

`main` deploys to Vercel. `scripts/migrate.mjs` runs before every build and applies `drizzle/*.sql` additively (it refuses destructive statements). A daily cron cleans expired rows.
