# OpsPulse roadmap (handoff)

**Goal:** an AI permission control center. A user adds OpsPulse as a connector in Claude (or ChatGPT/Cursor), logs in, clicks Allow, then just gives commands; OpsPulse applies their rules to every tool the AI can use. Not a task manager: tickets are only a built-in demo. Must work for any project/tool and be easy for non-technical owners (approve from phone/chat, plain language).

**Branch:** `feat/gateway-core` (not merged, not live). `main` = live authz/security/REST work.

## Done (tested, 49 tests incl. PGlite end-to-end)
- Gateway core `src/gateway/`: `service.ts` pipeline, `rules.ts` tiers + escalation, `events.ts` hash-chained log, `hashing.ts` AES-GCM secrets, `builtin/tickets.ts` demo project, `types.ts` contract (see `docs/gateway-contract.md`).
- Tiers: auto / undo (10 min) / ask / never; approval bound to input + preview hash; exactly-once via conditional updates.
- Dashboard API: `/api/overview`, `/api/projects`, `/api/requests`, `/api/activity`. MCP tools `<slug>__<action>` per workspace.
- SQL migrations in `drizzle/`.

## Written, NOT yet tested
`src/gateway/signing.ts`, `connectors/http.ts`, `connectors/mcp.ts` (wraps any MCP server), `packages/connect-node/`, `examples/demo-store/`.

## Next steps (in order)
1. Tests for signing, HTTP connector against demo-store, MCP connector against an in-process MCP server.
2. Accounts + OAuth 2.1/PKCE so claude.ai "Add custom connector" works; per-user workspaces replace the anonymous sandbox and shared `MCP_API_KEY` (keep the key path for Claude Code/Cursor). Login via GitHub/Google (needs an OAuth app: user logs in, Claude creates it).
3. Safe defaults on connect; rule packages (Careful / Balanced / Full access); time-boxed full access ("1 hour on GitHub"). Only a human can change rules.
4. Connect tools by MCP server URL (+ optional headers); one-click popular tools later.
5. Simple dashboard: Connected tools first, approvals, activity; tickets → Demo. Plain English, mobile-first, light + dark.
6. Approvals/undo from Telegram + email; daily report.
7. Remove legacy (`deletion_requests`, old approval helpers), rewrite README/docs, migrate prod DB, go live.

Constraints: Vercel Hobby cron is daily only. Next.js 16 — read `node_modules/next/dist/docs/` first (AGENTS.md). Don't touch the addiits project without the user's OK.
