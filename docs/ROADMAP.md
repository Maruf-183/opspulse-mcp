# OpsPulse roadmap (handoff)

**Goal:** an AI permission control center. A user adds OpsPulse as a connector in Claude (or ChatGPT/Cursor), logs in, clicks Allow, then just gives commands; OpsPulse applies their rules to every tool the AI can use. Not a task manager: tickets are only a built-in demo. Must work for any project/tool and be easy for non-technical owners (approve from phone/chat, plain language).

**Branch:** `feat/gateway-core` (not merged, not live). `main` = live authz/security/REST work.

## Done (81 tests, incl. PGlite end-to-end)
- Gateway core: four tiers, escalation, approvals bound to hashes, exactly-once, undo, hash-chained log.
- Connectors: builtin, HTTP (signed), MCP (wrap any server), OpenAPI 3 (no code), Postgres/MySQL (no code, undoable writes).
- MCP: three generic tools with project lookup by name; approval/undo links in results.
- Accounts: GitHub sign-in; OAuth 2.1 server for AI apps (PKCE, rotation, reuse detection); connected apps + disconnect.
- Dashboard (optional) and `/r/:id` one-page approvals; Python/PHP/Node connect kits; threat model; ADR 003.

## Next
1. Go live: production DB migration, GitHub OAuth app, Vercel env (SESSION_SECRET, GITHUB_CLIENT_ID/SECRET), merge to main, verify with claude.ai.
2. Email notifications for held requests; per-connection rate limits.
3. DNS-rebinding-safe fetch; anchor the activity chain head externally.
4. Organizations: several humans per workspace with roles; approver ≠ requester between humans.
