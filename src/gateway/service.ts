/**
 * Gateway service: the single pipeline every AI action goes through.
 *
 *   invokeAction ─► validate ─► decideTier ─┬─ never ─► denied
 *                                          ├─ auto  ─► execute
 *                                          ├─ undo  ─► execute + 10-minute undo window
 *                                          └─ ask   ─► preview ─► pending ─► approve ─► re-check ─► execute
 *
 * Every state change is a conditional UPDATE (`WHERE status = …`) so double
 * clicks, retries and concurrent approvals cannot run an action twice.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gatewayEvents, gatewayPolicies, gatewayProjects, gatewayRequests } from "@/db/schema";
import { can, type Permission, type Principal } from "@/lib/authz/policy";
import { fail, ok, type ServiceResult } from "@/services/result";
import { BUILTIN_TICKETS_ID, createTicketsConnector, ticketsManifest } from "./builtin/tickets";
import { createConnector } from "./connectors";
import { appendEvent } from "./events";
import { decryptSecret, encryptSecret, hashValue, newProjectSecret } from "./hashing";
import { decideTier, renderSummary } from "./rules";
import {
  APPROVAL_TTL_MS,
  UNDO_WINDOW_MS,
  projectManifestSchema,
  tierSchema,
  type ActionDef,
  type ActionPolicyDTO,
  type ActionRequestDTO,
  type ActivityEventDTO,
  type Connector,
  type OverviewDTO,
  type Preview,
  type ProjectDetailDTO,
  type ProjectManifest,
  type ProjectSummaryDTO,
  type RequestStatus,
  type Tier,
} from "./types";

export const TIER_LABEL: Record<Tier, string> = {
  auto: "Run automatically",
  undo: "Run, can undo for 10 minutes",
  ask: "Ask me first",
  never: "Never allow",
};

const actorName = (principal: Principal) => (principal.kind === "agent" ? "AI assistant" : "You");

function deny(principal: Principal, permission: Permission) {
  return can(principal, permission)
    ? null
    : fail("FORBIDDEN", principal.kind === "agent" ? "AI assistants cannot do this." : "You don't have permission to do this.");
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

type LoadedProject = {
  id: string;
  manifest: ProjectManifest;
  secret?: string;
  builtin: boolean;
  createdAt: Date;
};

const BUILTIN_CREATED_AT = new Date("2026-01-01T00:00:00Z");

async function loadProjects(principal: Principal): Promise<LoadedProject[]> {
  const rows = await db
    .select()
    .from(gatewayProjects)
    .where(eq(gatewayProjects.sandboxId, principal.sandboxId))
    .orderBy(gatewayProjects.createdAt);

  const external = rows.flatMap((row): LoadedProject[] => {
    const manifest = projectManifestSchema.safeParse(row.manifest);
    if (!manifest.success) return [];
    let secret: string | undefined;
    try {
      secret = row.secretCiphertext ? decryptSecret(row.secretCiphertext) : undefined;
    } catch {
      secret = undefined;
    }
    return [{ id: row.id, manifest: manifest.data, secret, builtin: false, createdAt: row.createdAt }];
  });

  return [
    { id: BUILTIN_TICKETS_ID, manifest: ticketsManifest, builtin: true, createdAt: BUILTIN_CREATED_AT },
    ...external,
  ];
}

async function loadProject(principal: Principal, projectId: string) {
  return (await loadProjects(principal)).find((project) => project.id === projectId) ?? null;
}

function connectorFor(principal: Principal, project: LoadedProject): Connector {
  if (project.manifest.connector.type === "mcp" && project.secret) {
    // Upstream MCP headers are stored encrypted, not in the manifest.
    const headers = JSON.parse(project.secret) as Record<string, string>;
    return createConnector(
      { ...project.manifest, connector: { ...project.manifest.connector, headers } },
      {},
    );
  }
  return createConnector(project.manifest, {
    secret: project.secret,
    builtin: project.builtin ? createTicketsConnector(principal) : undefined,
  });
}

async function actionsOf(principal: Principal, project: LoadedProject): Promise<ActionDef[]> {
  // MCP projects are always discovered live; manifest actions act as overrides.
  if (project.manifest.connector.type === "database") return connectorFor(principal, project).listActions();
  if (project.manifest.connector.type !== "mcp") return project.manifest.actions;
  try {
    return await connectorFor(principal, project).listActions();
  } catch (error) {
    console.error(`Could not discover actions for ${project.manifest.slug}:`, error);
    return [];
  }
}

async function overridesFor(sandboxId: string, projectId?: string) {
  const rows = await db
    .select()
    .from(gatewayPolicies)
    .where(
      projectId
        ? and(eq(gatewayPolicies.sandboxId, sandboxId), eq(gatewayPolicies.projectId, projectId))
        : eq(gatewayPolicies.sandboxId, sandboxId),
    );
  return new Map(rows.map((row) => [`${row.projectId}:${row.action}`, row.tier as Tier]));
}

async function pendingCounts(sandboxId: string) {
  const rows = await db
    .select({ projectId: gatewayRequests.projectId, n: count() })
    .from(gatewayRequests)
    .where(and(eq(gatewayRequests.sandboxId, sandboxId), eq(gatewayRequests.status, "pending")))
    .groupBy(gatewayRequests.projectId);
  return new Map(rows.map((row) => [row.projectId, Number(row.n)]));
}

function toSummaryDTO(project: LoadedProject, actionCount: number, pending: number): ProjectSummaryDTO {
  return {
    id: project.id,
    slug: project.manifest.slug,
    name: project.manifest.name,
    description: project.manifest.description,
    connectorType: project.manifest.connector.type,
    actionCount,
    pendingCount: pending,
    createdAt: project.createdAt.toISOString(),
  };
}

export async function listProjects(principal: Principal): Promise<ServiceResult<ProjectSummaryDTO[]>> {
  const denied = deny(principal, "project:read");
  if (denied) return denied;
  const [projects, pending] = await Promise.all([loadProjects(principal), pendingCounts(principal.sandboxId)]);
  return ok(
    projects.map((project) =>
      toSummaryDTO(project, project.manifest.actions.length, pending.get(project.id) ?? 0),
    ),
  );
}

export async function getProject(principal: Principal, projectId: string): Promise<ServiceResult<ProjectDetailDTO>> {
  const denied = deny(principal, "project:read");
  if (denied) return denied;
  const project = await loadProject(principal, projectId);
  if (!project) return fail("NOT_FOUND", "Project not found.");

  const [actions, overrides, pending] = await Promise.all([
    actionsOf(principal, project),
    overridesFor(principal.sandboxId, project.id),
    pendingCounts(principal.sandboxId),
  ]);
  const connector = project.manifest.connector;
  return ok({
    ...toSummaryDTO(project, actions.length, pending.get(project.id) ?? 0),
    connector: {
      type: connector.type,
      url: connector.type === "http" ? connector.baseUrl : connector.type === "mcp" ? connector.url : undefined,
    },
    actions: actions.map((action) => toPolicyDTO(action, overrides.get(`${project.id}:${action.name}`))),
  });
}

function toPolicyDTO(action: ActionDef, override: Tier | undefined): ActionPolicyDTO {
  return {
    name: action.name,
    title: action.title,
    description: action.description,
    defaultTier: action.tier,
    tier: override ?? action.tier,
    supportsUndo: action.undo,
    supportsPreview: action.preview,
    escalate: action.escalate,
  };
}

const RESERVED_SLUGS = new Set(["tickets", "opspulse", "dashboard", "api"]);

const createProjectInput = z.object({
  manifest: z.unknown(),
  /** MCP only: headers for the upstream server (e.g. an API token). Stored encrypted. */
  upstreamHeaders: z.record(z.string(), z.string()).optional(),
  /** Database only: connection URL (postgres://… or mysql://…). Stored encrypted, never returned. */
  connectionUrl: z.string().regex(/^(postgres(ql)?|mysql):\/\//, "Use a postgres:// or mysql:// connection link").optional(),
});

export async function createProject(
  principal: Principal,
  raw: unknown,
): Promise<ServiceResult<{ project: ProjectDetailDTO; secret?: string }>> {
  const denied = deny(principal, "project:manage");
  if (denied) return denied;

  const body = createProjectInput.safeParse(raw);
  if (!body.success) return fail("VALIDATION_FAILED", "Send { manifest }.", z.flattenError(body.error));
  const manifest = projectManifestSchema.safeParse(body.data.manifest);
  if (!manifest.success) {
    return fail("VALIDATION_FAILED", "The project description has problems.", z.flattenError(manifest.error));
  }
  const data = manifest.data;
  if (data.connector.type === "builtin") return fail("VALIDATION_FAILED", "Choose an HTTP or MCP connection.");
  if (RESERVED_SLUGS.has(data.slug)) return fail("VALIDATION_FAILED", `"${data.slug}" is reserved; pick another slug.`);
  if (data.connector.type === "database" && !body.data.connectionUrl) {
    return fail("VALIDATION_FAILED", "Add the database connection link.");
  }
  if (data.connector.type === "http" && data.actions.some((action) => !action.http)) {
    return fail("VALIDATION_FAILED", "Every action of an HTTP project needs an http { method, path }.");
  }

  const [existing] = await db
    .select({ id: gatewayProjects.id })
    .from(gatewayProjects)
    .where(and(eq(gatewayProjects.sandboxId, principal.sandboxId), eq(gatewayProjects.slug, data.slug)));
  if (existing) return fail("CONFLICT", `A project called "${data.slug}" already exists.`);

  let secret: string | undefined;
  let secretCiphertext: string | null = null;
  let stored: ProjectManifest = data;
  if (data.connector.type === "http") {
    secret = newProjectSecret();
    secretCiphertext = encryptSecret(secret);
  } else if (data.connector.type === "database") {
    secretCiphertext = encryptSecret(body.data.connectionUrl!);
  } else if (data.connector.type === "mcp") {
    const headers = { ...data.connector.headers, ...body.data.upstreamHeaders };
    secretCiphertext = Object.keys(headers).length ? encryptSecret(JSON.stringify(headers)) : null;
    stored = { ...data, connector: { ...data.connector, headers: {} } };
  }

  const id = randomUUID();
  await db.insert(gatewayProjects).values({
    id,
    sandboxId: principal.sandboxId,
    slug: data.slug,
    name: data.name,
    description: data.description,
    manifest: stored,
    secretCiphertext,
  });
  await appendEvent({
    sandboxId: principal.sandboxId,
    projectId: id,
    kind: "project.created",
    summary: `${actorName(principal)} connected the project "${data.name}"`,
    actor: principal.id,
  });

  const project = await getProject(principal, id);
  if (!project.ok) return project;
  return ok({ project: project.data, secret });
}

export async function deleteProject(principal: Principal, projectId: string): Promise<ServiceResult<{ deleted: true }>> {
  const denied = deny(principal, "project:manage");
  if (denied) return denied;
  if (projectId === BUILTIN_TICKETS_ID) return fail("VALIDATION_FAILED", "The demo project can't be removed.");

  const [removed] = await db
    .delete(gatewayProjects)
    .where(and(eq(gatewayProjects.id, projectId), eq(gatewayProjects.sandboxId, principal.sandboxId)))
    .returning({ name: gatewayProjects.name });
  if (!removed) return fail("NOT_FOUND", "Project not found.");

  await db.delete(gatewayPolicies).where(eq(gatewayPolicies.projectId, projectId));
  await db
    .update(gatewayRequests)
    .set({ status: "expired", error: "The project was disconnected.", decidedAt: new Date() })
    .where(and(eq(gatewayRequests.projectId, projectId), eq(gatewayRequests.status, "pending")));
  await appendEvent({
    sandboxId: principal.sandboxId,
    projectId,
    kind: "project.deleted",
    summary: `${actorName(principal)} disconnected the project "${removed.name}"`,
    actor: principal.id,
  });
  return ok({ deleted: true });
}

export async function setActionTier(
  principal: Principal,
  projectId: string,
  actionName: string,
  rawTier: unknown,
): Promise<ServiceResult<ActionPolicyDTO>> {
  const denied = deny(principal, "project:manage");
  if (denied) return denied;
  const tier = tierSchema.safeParse(rawTier);
  if (!tier.success) return fail("VALIDATION_FAILED", "Choose one of: auto, undo, ask, never.");

  const project = await loadProject(principal, projectId);
  if (!project) return fail("NOT_FOUND", "Project not found.");
  const action = (await actionsOf(principal, project)).find((a) => a.name === actionName);
  if (!action) return fail("NOT_FOUND", "Action not found.");
  if (tier.data === "undo" && !action.undo) {
    return fail("VALIDATION_FAILED", "This project can't undo this action, so it can't use the undo option.");
  }

  await db
    .insert(gatewayPolicies)
    .values({ projectId, sandboxId: principal.sandboxId, action: actionName, tier: tier.data })
    .onConflictDoUpdate({
      target: [gatewayPolicies.projectId, gatewayPolicies.action],
      set: { tier: tier.data, updatedAt: new Date() },
    });
  await appendEvent({
    sandboxId: principal.sandboxId,
    projectId,
    kind: "policy.changed",
    summary: `${actorName(principal)} set "${action.title}" to "${TIER_LABEL[tier.data]}"`,
    actor: principal.id,
    data: { action: actionName, tier: tier.data },
  });
  return ok(toPolicyDTO(action, tier.data));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type RequestRow = typeof gatewayRequests.$inferSelect;

function toRequestDTO(row: RequestRow, project: LoadedProject | undefined, action: ActionDef | undefined): ActionRequestDTO {
  const undoOpen = row.status === "executed" && row.undoToken && row.undoUntil && row.undoUntil > new Date();
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: project?.manifest.name ?? "Disconnected project",
    action: row.action,
    actionTitle: action?.title ?? row.action,
    summary: row.summary,
    tier: row.tier,
    reasons: (row.reasons as string[]) ?? [],
    status: row.status,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    input: row.input as Record<string, unknown>,
    preview: (row.preview as Preview | null) ?? null,
    result: row.result ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    undoUntil: undoOpen ? row.undoUntil!.toISOString() : null,
  };
}

async function hydrate(principal: Principal, rows: RequestRow[]): Promise<ActionRequestDTO[]> {
  const projects = new Map((await loadProjects(principal)).map((p) => [p.id, p]));
  return rows.map((row) => {
    const project = projects.get(row.projectId);
    return toRequestDTO(row, project, project?.manifest.actions.find((a) => a.name === row.action));
  });
}

/** Marks pending requests past their deadline as expired (lazy, idempotent). */
async function expireStale(sandboxId: string) {
  await db
    .update(gatewayRequests)
    .set({ status: "expired", error: "Nobody answered in time.", decidedAt: new Date() })
    .where(
      and(
        eq(gatewayRequests.sandboxId, sandboxId),
        eq(gatewayRequests.status, "pending"),
        lt(gatewayRequests.expiresAt, new Date()),
      ),
    );
}

export type InvokeOutcome = ActionRequestDTO;

const safeMessage = (error: unknown) =>
  (error instanceof Error ? error.message : "The project returned an error.").slice(0, 300);

/** Runs a claimed request against its project and records the outcome. */
async function runClaimed(
  principal: Principal,
  project: LoadedProject,
  action: ActionDef,
  row: RequestRow,
): Promise<RequestRow> {
  const connector = connectorFor(principal, project);
  try {
    const response = await connector.execute(action, row.input as Record<string, unknown>, {
      requestId: row.id,
      secret: project.secret,
    });
    const canUndo = action.undo && Boolean(response.undoToken) && Boolean(connector.undo);
    const [done] = await db
      .update(gatewayRequests)
      .set({
        status: "executed",
        result: (response.result ?? null) as object | null,
        undoToken: canUndo ? response.undoToken! : null,
        undoUntil: canUndo ? new Date(Date.now() + UNDO_WINDOW_MS) : null,
      })
      .where(and(eq(gatewayRequests.id, row.id), eq(gatewayRequests.status, "approved")))
      .returning();
    await appendEvent({
      sandboxId: row.sandboxId,
      projectId: row.projectId,
      requestId: row.id,
      kind: "request.executed",
      summary: `${row.requestedBy.startsWith("browser:") ? "You" : "AI assistant"}: ${row.summary}`,
      actor: row.requestedBy,
      data: { tier: row.tier, canUndo },
    });
    return done ?? row;
  } catch (error) {
    const message = safeMessage(error);
    const [failed] = await db
      .update(gatewayRequests)
      .set({ status: "failed", error: message })
      .where(and(eq(gatewayRequests.id, row.id), eq(gatewayRequests.status, "approved")))
      .returning();
    await appendEvent({
      sandboxId: row.sandboxId,
      projectId: row.projectId,
      requestId: row.id,
      kind: "request.failed",
      summary: `Couldn't finish: ${row.summary} (${message})`,
      actor: row.requestedBy,
    });
    return failed ?? row;
  }
}

export async function invokeAction(
  principal: Principal,
  projectId: string,
  actionName: string,
  rawInput: unknown,
): Promise<ServiceResult<InvokeOutcome>> {
  const denied = deny(principal, "project:invoke");
  if (denied) return denied;

  const project = await loadProject(principal, projectId);
  if (!project) return fail("NOT_FOUND", "Project not found.");
  const action = (await actionsOf(principal, project)).find((a) => a.name === actionName);
  if (!action) return fail("NOT_FOUND", `This project has no action called "${actionName}".`);

  const validator = z.fromJSONSchema(action.input as Parameters<typeof z.fromJSONSchema>[0]);
  const parsedInput = validator.safeParse(rawInput ?? {});
  if (!parsedInput.success) {
    return fail("VALIDATION_FAILED", "The request is missing information or has invalid values.", z.flattenError(parsedInput.error));
  }
  const input = (parsedInput.data ?? {}) as Record<string, unknown>;

  const overrides = await overridesFor(principal.sandboxId, project.id);
  const [{ n: priorExecutions } = { n: 0 }] = await db
    .select({ n: count() })
    .from(gatewayRequests)
    .where(
      and(
        eq(gatewayRequests.sandboxId, principal.sandboxId),
        eq(gatewayRequests.projectId, project.id),
        eq(gatewayRequests.action, action.name),
        inArray(gatewayRequests.status, ["executed", "undone"]),
      ),
    );
  const decision = decideTier(action, overrides.get(`${project.id}:${action.name}`), input, {
    now: new Date(),
    priorExecutions: Number(priorExecutions),
  });

  const id = randomUUID();
  const summary = renderSummary(action.summary, input);
  const base = {
    id,
    sandboxId: principal.sandboxId,
    projectId: project.id,
    action: action.name,
    input,
    inputHash: hashValue(input),
    summary,
    tier: decision.tier,
    reasons: decision.reasons,
    requestedBy: principal.id,
  };

  if (decision.tier === "never") {
    const [row] = await db.insert(gatewayRequests).values({ ...base, status: "denied" }).returning();
    await appendEvent({
      sandboxId: principal.sandboxId,
      projectId: project.id,
      requestId: id,
      kind: "request.denied",
      summary: `Blocked: ${summary}`,
      actor: principal.id,
    });
    return ok(toRequestDTO(row!, project, action));
  }

  if (decision.tier === "ask") {
    let preview: Preview | null = null;
    const connector = connectorFor(principal, project);
    if (action.preview && connector.preview) {
      try {
        preview = await connector.preview(action, input, { requestId: id, secret: project.secret });
      } catch (error) {
        return fail("VALIDATION_FAILED", `Couldn't prepare this request: ${safeMessage(error)}`);
      }
    }
    const [row] = await db
      .insert(gatewayRequests)
      .values({
        ...base,
        status: "pending",
        preview,
        previewHash: preview ? hashValue(preview) : null,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      })
      .returning();
    await appendEvent({
      sandboxId: principal.sandboxId,
      projectId: project.id,
      requestId: id,
      kind: "request.pending",
      summary: `Waiting for your OK: ${summary}`,
      actor: principal.id,
      data: { reasons: decision.reasons },
    });
    return ok(toRequestDTO(row!, project, action));
  }

  // auto / undo: claim and run immediately.
  const [claimed] = await db
    .insert(gatewayRequests)
    .values({ ...base, status: "approved", decidedBy: "policy", decidedAt: new Date() })
    .returning();
  const finished = await runClaimed(principal, project, action, claimed!);
  return ok(toRequestDTO(finished, project, action));
}

async function loadRequest(principal: Principal, id: string) {
  const [row] = await db
    .select()
    .from(gatewayRequests)
    .where(and(eq(gatewayRequests.id, id), eq(gatewayRequests.sandboxId, principal.sandboxId)));
  return row ?? null;
}

export async function approveRequest(principal: Principal, id: string): Promise<ServiceResult<ActionRequestDTO>> {
  const denied = deny(principal, "request:decide");
  if (denied) return denied;

  const row = await loadRequest(principal, id);
  if (!row) return fail("NOT_FOUND", "Request not found.");
  const project = await loadProject(principal, row.projectId);
  const action = project && (await actionsOf(principal, project)).find((a) => a.name === row.action);
  if (row.status !== "pending") {
    return fail("CONFLICT", "This request has already been handled.", (await hydrate(principal, [row]))[0]);
  }

  const expire = async (reason: string) => {
    const [expired] = await db
      .update(gatewayRequests)
      .set({ status: "expired", error: reason, decidedBy: principal.id, decidedAt: new Date() })
      .where(and(eq(gatewayRequests.id, id), eq(gatewayRequests.status, "pending")))
      .returning();
    await appendEvent({
      sandboxId: row.sandboxId,
      projectId: row.projectId,
      requestId: id,
      kind: "request.expired",
      summary: `Not run: ${row.summary} — ${reason}`,
      actor: principal.id,
    });
    return fail("CONFLICT", reason, expired ? toRequestDTO(expired, project ?? undefined, action ?? undefined) : undefined);
  };

  if (!project || !action) return expire("The project or action no longer exists.");
  if (row.expiresAt && row.expiresAt < new Date()) return expire("This request expired before it was approved.");

  // What you approve is what runs: the stored input must still hash the same,
  // and the project's preview must still describe the same change.
  if (hashValue(row.input) !== row.inputHash) return expire("The request was modified after it was created.");
  if (row.previewHash) {
    const connector = connectorFor(principal, project);
    try {
      const fresh = await connector.preview!(action, row.input as Record<string, unknown>, {
        requestId: row.id,
        secret: project.secret,
      });
      if (hashValue(fresh) !== row.previewHash) {
        return expire("Things changed since you looked at it. Ask the AI to try again so you can review the new version.");
      }
    } catch (error) {
      return expire(`Couldn't re-check the change: ${safeMessage(error)}`);
    }
  }

  const [claimed] = await db
    .update(gatewayRequests)
    .set({ status: "approved", decidedBy: principal.id, decidedAt: new Date() })
    .where(and(eq(gatewayRequests.id, id), eq(gatewayRequests.status, "pending")))
    .returning();
  if (!claimed) return fail("CONFLICT", "This request has already been handled.");

  await appendEvent({
    sandboxId: row.sandboxId,
    projectId: row.projectId,
    requestId: id,
    kind: "request.approved",
    summary: `${actorName(principal)} approved: ${row.summary}`,
    actor: principal.id,
  });
  const finished = await runClaimed(principal, project, action, claimed);
  return ok(toRequestDTO(finished, project, action));
}

export async function rejectRequest(principal: Principal, id: string): Promise<ServiceResult<ActionRequestDTO>> {
  const denied = deny(principal, "request:decide");
  if (denied) return denied;
  const [row] = await db
    .update(gatewayRequests)
    .set({ status: "rejected", decidedBy: principal.id, decidedAt: new Date() })
    .where(
      and(
        eq(gatewayRequests.id, id),
        eq(gatewayRequests.sandboxId, principal.sandboxId),
        eq(gatewayRequests.status, "pending"),
      ),
    )
    .returning();
  if (!row) return fail("CONFLICT", "This request is no longer waiting for a decision.");
  await appendEvent({
    sandboxId: row.sandboxId,
    projectId: row.projectId,
    requestId: id,
    kind: "request.rejected",
    summary: `${actorName(principal)} declined: ${row.summary}`,
    actor: principal.id,
  });
  return ok((await hydrate(principal, [row]))[0]!);
}

export async function undoRequest(principal: Principal, id: string): Promise<ServiceResult<ActionRequestDTO>> {
  const denied = deny(principal, "request:decide");
  if (denied) return denied;

  // Claim first so a double click can't undo twice.
  const [claimed] = await db
    .update(gatewayRequests)
    .set({ status: "undone" })
    .where(
      and(
        eq(gatewayRequests.id, id),
        eq(gatewayRequests.sandboxId, principal.sandboxId),
        eq(gatewayRequests.status, "executed"),
        gte(gatewayRequests.undoUntil, new Date()),
        sql`${gatewayRequests.undoToken} IS NOT NULL`,
      ),
    )
    .returning();
  if (!claimed) return fail("CONFLICT", "This can no longer be undone.");

  const project = await loadProject(principal, claimed.projectId);
  const action = project && (await actionsOf(principal, project)).find((a) => a.name === claimed.action);
  const connector = project && connectorFor(principal, project);
  try {
    if (!project || !action || !connector?.undo) throw new Error("The project no longer supports undo.");
    await connector.undo(action, claimed.undoToken!, { requestId: claimed.id, secret: project.secret });
  } catch (error) {
    const message = safeMessage(error);
    await db
      .update(gatewayRequests)
      .set({ status: "executed", error: `Undo failed: ${message}` })
      .where(eq(gatewayRequests.id, id));
    return fail("INTERNAL", `Undo failed: ${message}`);
  }

  await db.update(gatewayRequests).set({ undoToken: null, undoUntil: null }).where(eq(gatewayRequests.id, id));
  await appendEvent({
    sandboxId: claimed.sandboxId,
    projectId: claimed.projectId,
    requestId: id,
    kind: "request.undone",
    summary: `${actorName(principal)} undid: ${claimed.summary}`,
    actor: principal.id,
  });
  return ok(toRequestDTO({ ...claimed, undoToken: null, undoUntil: null }, project, action));
}

export async function listRequests(
  principal: Principal,
  status?: RequestStatus,
  limit = 50,
): Promise<ServiceResult<ActionRequestDTO[]>> {
  const denied = deny(principal, "project:read");
  if (denied) return denied;
  await expireStale(principal.sandboxId);
  const rows = await db
    .select()
    .from(gatewayRequests)
    .where(
      status
        ? and(eq(gatewayRequests.sandboxId, principal.sandboxId), eq(gatewayRequests.status, status))
        : eq(gatewayRequests.sandboxId, principal.sandboxId),
    )
    .orderBy(desc(gatewayRequests.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return ok(await hydrate(principal, rows));
}

export async function getRequest(principal: Principal, id: string): Promise<ServiceResult<ActionRequestDTO>> {
  const denied = deny(principal, "project:read");
  if (denied) return denied;
  const row = await loadRequest(principal, id);
  if (!row) return fail("NOT_FOUND", "Request not found.");
  return ok((await hydrate(principal, [row]))[0]!);
}

// ---------------------------------------------------------------------------
// Activity + overview
// ---------------------------------------------------------------------------

export async function listActivity(principal: Principal, limit = 50): Promise<ServiceResult<ActivityEventDTO[]>> {
  const denied = deny(principal, "audit:read");
  if (denied) return denied;
  const [rows, projects] = await Promise.all([
    db
      .select()
      .from(gatewayEvents)
      .where(eq(gatewayEvents.sandboxId, principal.sandboxId))
      .orderBy(desc(gatewayEvents.id))
      .limit(Math.min(Math.max(limit, 1), 200)),
    loadProjects(principal),
  ]);
  const names = new Map(projects.map((p) => [p.id, p.manifest.name]));
  return ok(
    rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      projectName: row.projectId ? (names.get(row.projectId) ?? null) : null,
      kind: row.kind,
      summary: row.summary,
      actor: row.actor,
      createdAt: row.createdAt.toISOString(),
      hash: row.hash,
    })),
  );
}

export async function getOverview(principal: Principal): Promise<ServiceResult<OverviewDTO>> {
  const denied = deny(principal, "project:read");
  if (denied) return denied;
  await expireStale(principal.sandboxId);

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [counts, pending, recent, projects] = await Promise.all([
    db
      .select({ status: gatewayRequests.status, n: count() })
      .from(gatewayRequests)
      .where(and(eq(gatewayRequests.sandboxId, principal.sandboxId), gte(gatewayRequests.createdAt, startOfDay)))
      .groupBy(gatewayRequests.status),
    listRequests(principal, "pending", 20),
    listActivity(principal, 15),
    listProjects(principal),
  ]);
  const by = new Map(counts.map((row) => [row.status, Number(row.n)]));
  return ok({
    today: {
      done: by.get("executed") ?? 0,
      waiting: by.get("pending") ?? 0,
      blocked: (by.get("denied") ?? 0) + (by.get("rejected") ?? 0),
      undone: by.get("undone") ?? 0,
    },
    pending: pending.ok ? pending.data : [],
    recent: recent.ok ? recent.data : [],
    projects: projects.ok ? projects.data : [],
  });
}

// ---------------------------------------------------------------------------
// MCP tool catalogue
// ---------------------------------------------------------------------------

export type ToolEntry = {
  name: string;
  projectId: string;
  action: ActionDef;
  tier: Tier;
  projectName: string;
};

/** Every action this principal can call, named `<slug>__<action>`. */
export async function toolCatalogue(principal: Principal): Promise<ToolEntry[]> {
  if (!can(principal, "project:invoke")) return [];
  const [projects, overrides] = await Promise.all([loadProjects(principal), overridesFor(principal.sandboxId)]);
  const entries = await Promise.all(
    projects.map(async (project) =>
      (await actionsOf(principal, project)).map((action) => ({
        name: `${project.manifest.slug}__${action.name}`,
        projectId: project.id,
        action,
        tier: overrides.get(`${project.id}:${action.name}`) ?? action.tier,
        projectName: project.manifest.name,
      })),
    ),
  );
  return entries.flat().filter((entry) => entry.tier !== "never");
}
