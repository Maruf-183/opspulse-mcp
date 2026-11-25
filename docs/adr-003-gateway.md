# ADR 003: A project-agnostic gateway with four tiers, previews and undo

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

OpsPulse started as a single-purpose demo. The real need is broader: let any AI assistant work on any system a business uses, while the owner stays in control without being asked about everything. Existing tools focus on blocking calls for developers; the people approving are often non-technical and approve without reading when asked too often.

## Decisions

1. **One pipeline for every system.** Projects are described by a manifest (actions, input schemas, default tiers) and reached through a `Connector` (`builtin`, `http`, `mcp`, `openapi`, `database`). The pipeline never knows what system it is talking to.
2. **Four tiers, not two.** `auto`, `undo`, `ask`, `never`. Reversible work runs immediately with a 10-minute undo, which removes most approval prompts. `undo` is only offered when the connector can actually reverse the action.
3. **Explainable escalation.** Rules such as "more than N items", "first time" and "quiet hours" can only make a decision stricter, and always produce a human-readable reason. No opaque scoring.
4. **Approve exactly what was shown.** Input and preview hashes are stored with the request and re-checked at approval.
5. **Three generic MCP tools** (`list_projects`, `find_actions`, `run_action`) instead of one tool per action, so the tool list stays small and people can name projects in their own words.
6. **Approvals don't require a dashboard.** Held results carry a `/r/:id` link that only the signed-in owner can act on.
7. **AI apps authenticate as the user via OAuth 2.1**; the shared server key remains for the in-app assistant and developer tools.

## Consequences

- New systems usually need no code (MCP, OpenAPI, database). Custom HTTP integrations need a manifest and a signature check.
- Previews and undo depend on connector support; external MCP and OpenAPI actions default to `ask`.
- The gateway stores more state (requests, events) and must be migrated with the app; migrations are versioned in `drizzle/`.

## Alternatives considered

- **One MCP tool per action:** simple, but degrades model accuracy as projects grow and leaks project structure into the tool list.
- **Policy engines (Cerbos, OPA):** strong for attribute-based access, but they answer "allowed or not", not "run now, run with undo, or ask with a preview". The tier engine is small enough to keep in-house and fully tested.
- **Blocking until approval:** fragile over HTTP and ties up the AI; OpsPulse returns immediately and executes on approval.
