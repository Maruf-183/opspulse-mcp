CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"action" text NOT NULL,
	"input_payload" text NOT NULL,
	"output_payload" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"is_error" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "gateway_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"project_id" text,
	"request_id" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"actor" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_policies" (
	"project_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"action" text NOT NULL,
	"tier" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_policies_project_id_action_pk" PRIMARY KEY("project_id","action")
);
--> statement-breakpoint
CREATE TABLE "gateway_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"manifest" jsonb NOT NULL,
	"secret_ciphertext" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"project_id" text NOT NULL,
	"action" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"preview" jsonb,
	"preview_hash" text,
	"summary" text NOT NULL,
	"tier" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"result" jsonb,
	"error" text,
	"undo_token" text,
	"undo_until" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_audit_sandbox" ON "audit_logs" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "idx_deletions_sandbox" ON "deletion_requests" USING btree ("sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gateway_events_chain" ON "gateway_events" USING btree ("sandbox_id","prev_hash");--> statement-breakpoint
CREATE INDEX "idx_gateway_events_sandbox" ON "gateway_events" USING btree ("sandbox_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gateway_projects_slug" ON "gateway_projects" USING btree ("sandbox_id","slug");--> statement-breakpoint
CREATE INDEX "idx_gateway_requests_sandbox_status" ON "gateway_requests" USING btree ("sandbox_id","status");--> statement-breakpoint
CREATE INDEX "idx_gateway_requests_project_action" ON "gateway_requests" USING btree ("project_id","action");--> statement-breakpoint
CREATE INDEX "idx_tickets_sandbox" ON "tickets" USING btree ("sandbox_id");