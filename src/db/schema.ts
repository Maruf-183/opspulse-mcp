import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
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
