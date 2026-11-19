/**
 * OpsPulse Gateway — shared contract.
 *
 * This file is the single source of truth that the core, the connectors and
 * the dashboard UI are built against. Change it deliberately.
 *
 *   AI agent ──► MCP tool ──► invokeAction() ──► tier decision ──► connector ──► project
 *                                   │
 *                                   └─► approval request (ask) / undo window (undo) / denial (never)
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * auto  — run immediately.
 * undo  — run immediately; a human can reverse it within the undo window.
 *         Requires the connector to support undo, otherwise behaves as `ask`.
 * ask   — hold until a human approves the exact action shown to them.
 * never — always refuse.
 */
export const TIERS = ["auto", "undo", "ask", "never"] as const;
export const tierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof tierSchema>;

export const UNDO_WINDOW_MS = 10 * 60 * 1000;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Ordered from least to most restrictive. Escalation only moves right. */
export const TIER_ORDER: Record<Tier, number> = { auto: 0, undo: 1, ask: 2, never: 3 };
export const stricterTier = (a: Tier, b: Tier): Tier => (TIER_ORDER[a] >= TIER_ORDER[b] ? a : b);

// ---------------------------------------------------------------------------
// Project manifest
// ---------------------------------------------------------------------------

const actionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,47}$/, "Use snake_case, 2-48 chars, starting with a letter");

const httpRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Relative to the project's baseUrl. `{field}` placeholders are filled from input. */
  path: z.string().startsWith("/"),
});

/** Simple, explainable escalation rules — each produces a human-readable reason. */
export const escalationRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("max_items"),
    /** Input field holding an array (or a number) to count. */
    field: z.string(),
    max: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("first_time"),
  }),
  z.object({
    type: z.literal("quiet_hours"),
    /** Inclusive start / exclusive end, 0-23, in `timezone`. */
    from: z.number().int().min(0).max(23),
    to: z.number().int().min(0).max(23),
    timezone: z.string().default("UTC"),
  }),
]);
export type EscalationRule = z.infer<typeof escalationRuleSchema>;

export const actionDefSchema = z.object({
  name: actionNameSchema,
  /** Plain-language title shown to non-technical users, e.g. "Publish a blog post". */
  title: z.string().min(3).max(80),
  description: z.string().max(500).default(""),
  /** JSON Schema (object) describing the input. Shown to the AI as the tool schema. */
  input: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
  /** Default tier; the workspace owner can override it per action. */
  tier: tierSchema.default("ask"),
  /**
   * Plain-language sentence with `{field}` placeholders, rendered for approval
   * cards and the activity feed, e.g. `Publish "{title}" on the website`.
   */
  summary: z.string().max(200),
  /** HTTP connector only. */
  http: httpRouteSchema.optional(),
  /** Whether the project can preview (dry-run) this action. */
  preview: z.boolean().default(false),
  /** Whether the project can reverse this action. Required for the `undo` tier. */
  undo: z.boolean().default(false),
  escalate: z.array(escalationRuleSchema).default([]),
});
export type ActionDef = z.infer<typeof actionDefSchema>;

export const connectorConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("builtin") }),
  z.object({
    type: z.literal("http"),
    baseUrl: z.url(),
  }),
  z.object({
    type: z.literal("mcp"),
    url: z.url(),
    /** Static headers for the upstream MCP server (stored server-side only). */
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export const projectManifestSchema = z.object({
  /** URL-safe identifier, also the MCP tool prefix: `<slug>__<action>`. */
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  name: z.string().min(2).max(60),
  description: z.string().max(300).default(""),
  connector: connectorConfigSchema,
  /** For MCP connectors, actions can be omitted and are discovered from tools/list. */
  actions: z.array(actionDefSchema).default([]),
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

// ---------------------------------------------------------------------------
// Wire protocol between OpsPulse and an HTTP project
// ---------------------------------------------------------------------------

/**
 * Every request OpsPulse sends to a project carries:
 *   x-opspulse-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${requestId}.${METHOD}.${path}.${sha256(body)}`)>
 *   x-opspulse-request-id: <uuid>   — idempotency key; the same id must not run twice
 *   x-opspulse-mode: execute | preview | undo
 * Projects must reject signatures older than 5 minutes.
 */
export const SIGNATURE_HEADER = "x-opspulse-signature";
export const REQUEST_ID_HEADER = "x-opspulse-request-id";
export const MODE_HEADER = "x-opspulse-mode";
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export type ConnectorMode = "execute" | "preview" | "undo";

export const previewResponseSchema = z.object({
  /** What will change, as label/before/after rows, e.g. { label: "Status", before: "Draft", after: "Published" }. */
  changes: z
    .array(z.object({ label: z.string(), before: z.string().nullable(), after: z.string().nullable() }))
    .default([]),
  /** Consequences a human should notice, e.g. "1,240 subscribers will be emailed". */
  warnings: z.array(z.string()).default([]),
});
export type Preview = z.infer<typeof previewResponseSchema>;

export const executeResponseSchema = z.object({
  /** Arbitrary result returned to the AI. */
  result: z.unknown().optional(),
  /** Opaque token the project needs to reverse this action. */
  undoToken: z.string().max(2000).optional(),
});
export type ExecuteResponse = z.infer<typeof executeResponseSchema>;

// ---------------------------------------------------------------------------
// Connector interface — implemented by builtin, http and mcp connectors
// ---------------------------------------------------------------------------

export type ConnectorContext = {
  /** Stable id for this invocation; used as the idempotency key. */
  requestId: string;
  /** Per-project HMAC secret (HTTP connector). */
  secret?: string;
};

export interface Connector {
  /** Actions this project exposes (from the manifest or discovered upstream). */
  listActions(): Promise<ActionDef[]>;
  execute(action: ActionDef, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ExecuteResponse>;
  preview?(action: ActionDef, input: Record<string, unknown>, ctx: ConnectorContext): Promise<Preview>;
  undo?(action: ActionDef, undoToken: string, ctx: ConnectorContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Action requests (one row per AI invocation)
// ---------------------------------------------------------------------------

export const REQUEST_STATUSES = [
  "pending", // waiting for a human (tier ask)
  "approved", // human approved; execution claimed
  "executed", // ran successfully
  "rejected", // human said no
  "expired", // nobody answered in time, or the preview no longer matches
  "denied", // tier never, or permission check failed
  "failed", // project returned an error
  "undone", // reversed within the undo window
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// ---------------------------------------------------------------------------
// Dashboard API DTOs (consumed by the UI)
// ---------------------------------------------------------------------------

export type ProjectSummaryDTO = {
  id: string;
  slug: string;
  name: string;
  description: string;
  connectorType: ConnectorConfig["type"];
  actionCount: number;
  pendingCount: number;
  createdAt: string;
};

export type ActionPolicyDTO = {
  name: string;
  title: string;
  description: string;
  defaultTier: Tier;
  tier: Tier;
  /** False when the project cannot reverse it — the UI must disable the `undo` option. */
  supportsUndo: boolean;
  supportsPreview: boolean;
  escalate: EscalationRule[];
};

export type ProjectDetailDTO = ProjectSummaryDTO & {
  connector: { type: ConnectorConfig["type"]; url?: string };
  actions: ActionPolicyDTO[];
};

export type ActionRequestDTO = {
  id: string;
  projectId: string;
  projectName: string;
  action: string;
  actionTitle: string;
  /** Rendered plain-language summary, e.g. `Publish "AI in 2027" on the website`. */
  summary: string;
  tier: Tier;
  /** Why this was escalated, e.g. "Usually 1 item; this time 50". Empty if not escalated. */
  reasons: string[];
  status: RequestStatus;
  requestedBy: string;
  decidedBy: string | null;
  input: Record<string, unknown>;
  preview: Preview | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  /** Set when the action can still be undone. */
  undoUntil: string | null;
};

export type ActivityEventDTO = {
  id: number;
  projectId: string | null;
  projectName: string | null;
  /** Machine-readable kind, e.g. "request.executed". */
  kind: string;
  /** Plain-language sentence for the activity feed. */
  summary: string;
  actor: string;
  createdAt: string;
  /** Tamper-evidence: hash of this event chained to the previous one. */
  hash: string;
};

export type OverviewDTO = {
  today: { done: number; waiting: number; blocked: number; undone: number };
  pending: ActionRequestDTO[];
  recent: ActivityEventDTO[];
  projects: ProjectSummaryDTO[];
};
