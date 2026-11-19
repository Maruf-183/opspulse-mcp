import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
  jsonb,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const tickets = pgTable(
  "tickets",
  {
    id: serial("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    priority: text("priority", { enum: ["LOW", "MEDIUM", "HIGH"] })
      .notNull()
      .default("MEDIUM"),
    status: text("status", { enum: ["OPEN", "IN_PROGRESS", "RESOLVED"] })
      .notNull()
      .default("OPEN"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("idx_tickets_sandbox").on(table.sandboxId)]
);

export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: serial("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    ticketId: integer("ticket_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: ["PENDING", "APPROVED", "REJECTED"] })
      .notNull()
      .default("PENDING"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => [index("idx_deletions_sandbox").on(table.sandboxId)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    action: text("action").notNull(),
    inputPayload: text("input_payload").notNull(),
    outputPayload: text("output_payload").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    isError: integer("is_error").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_audit_sandbox").on(table.sandboxId)]
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(), // e.g., "ip:127.0.0.1" or "global:2026-11-17"
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/** A project connected to the gateway. Scoped to a workspace (sandbox). */
export const gatewayProjects = pgTable(
  "gateway_projects",
  {
    id: text("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** ProjectManifest without secrets. */
    manifest: jsonb("manifest").notNull(),
    /** AES-256-GCM encrypted signing secret (HTTP projects) or upstream headers (MCP). */
    secretCiphertext: text("secret_ciphertext"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("uq_gateway_projects_slug").on(table.sandboxId, table.slug)],
);

/** Owner's per-action tier overrides. */
export const gatewayPolicies = pgTable(
  "gateway_policies",
  {
    projectId: text("project_id").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    action: text("action").notNull(),
    tier: text("tier", { enum: ["auto", "undo", "ask", "never"] }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.action] })],
);

/** One row per AI invocation of a project action. */
export const gatewayRequests = pgTable(
  "gateway_requests",
  {
    id: text("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    projectId: text("project_id").notNull(),
    action: text("action").notNull(),
    input: jsonb("input").notNull(),
    /** sha256 of canonical input — approval is bound to exactly this. */
    inputHash: text("input_hash").notNull(),
    preview: jsonb("preview"),
    previewHash: text("preview_hash"),
    summary: text("summary").notNull(),
    tier: text("tier", { enum: ["auto", "undo", "ask", "never"] }).notNull(),
    reasons: jsonb("reasons").notNull().default([]),
    status: text("status", {
      enum: ["pending", "approved", "executed", "rejected", "expired", "denied", "failed", "undone"],
    }).notNull(),
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    result: jsonb("result"),
    error: text("error"),
    undoToken: text("undo_token"),
    undoUntil: timestamp("undo_until"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
  },
  (table) => [
    index("idx_gateway_requests_sandbox_status").on(table.sandboxId, table.status),
    index("idx_gateway_requests_project_action").on(table.projectId, table.action),
  ],
);

/**
 * Append-only, hash-chained activity log. Each event's hash covers the
 * previous event's hash, so editing or deleting a past event breaks the chain.
 * The unique (sandbox_id, prev_hash) index prevents two concurrent appends
 * from forking the chain — the loser retries on the new head.
 */
export const gatewayEvents = pgTable(
  "gateway_events",
  {
    id: serial("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    projectId: text("project_id"),
    requestId: text("request_id"),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    actor: text("actor").notNull(),
    data: jsonb("data").notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_gateway_events_chain").on(table.sandboxId, table.prevHash),
    index("idx_gateway_events_sandbox").on(table.sandboxId, table.id),
  ],
);
