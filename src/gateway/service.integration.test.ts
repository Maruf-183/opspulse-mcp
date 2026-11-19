/**
 * End-to-end tests of the gateway pipeline against a real Postgres (PGlite,
 * in-process) using the same SQL migrations that production runs.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/authz/policy";

vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  const client = new PGlite();
  const dir = path.resolve(import.meta.dirname, "../../drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  return { db: drizzle(client, { schema }) };
});

const { db } = await import("@/db");
const { gatewayEvents, tickets } = await import("@/db/schema");
const service = await import("./service");
const { verifyWorkspaceChain } = await import("./events");
const { BUILTIN_TICKETS_ID } = await import("./builtin/tickets");
const { eq } = await import("drizzle-orm");

let n = 0;
function workspace() {
  const sandboxId = `sbx_${(++n).toString(16).padStart(24, "0")}`;
  const human: Principal = { kind: "human", id: `browser:${sandboxId}`, role: "operator", sandboxId };
  const agent: Principal = { kind: "agent", id: `assistant:${sandboxId}`, role: "agent", sandboxId };
  return { sandboxId, human, agent };
}

const invoke = (p: Principal, action: string, input: unknown) =>
  service.invokeAction(p, BUILTIN_TICKETS_ID, action, input);

async function createTicket(p: Principal, title = "Database latency spike") {
  const res = await invoke(p, "create_ticket", { title, description: "p99 above 2s on primary", priority: "HIGH" });
  if (!res.ok) throw new Error(res.error);
  return (res.data.result as { id: number }).id;
}

beforeAll(() => {
  vi.useRealTimers();
});

describe("gateway pipeline", () => {
  it("runs auto actions immediately and records them", async () => {
    const { agent } = workspace();
    const res = await invoke(agent, "create_ticket", { title: "Disk full", description: "Root volume at 99%" });
    expect(res.ok && res.data.status).toBe("executed");
  });

  it("rejects input that does not match the action schema", async () => {
    const { agent } = workspace();
    const res = await invoke(agent, "create_ticket", { title: "x" });
    expect(res).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });

  it("runs undo-tier actions and lets a human reverse them, once", async () => {
    const { agent, human } = workspace();
    const id = await createTicket(agent);
    const res = await invoke(agent, "update_ticket", { ticketId: id, status: "RESOLVED" });
    // quiet-hours escalation may apply depending on the clock; force a deterministic path:
    if (!res.ok) throw new Error(res.error);
    if (res.data.status === "pending") {
      const approved = await service.approveRequest(human, res.data.id);
      expect(approved.ok && approved.data.status).toBe("executed");
    }
    const request = res.ok && res.data.status === "pending" ? (await service.getRequest(human, res.data.id)) : res;
    if (!request.ok) throw new Error(request.error);
    expect(request.data.undoUntil).not.toBeNull();

    const [after] = await db.select().from(tickets).where(eq(tickets.id, id));
    expect(after?.status).toBe("RESOLVED");

    const undone = await service.undoRequest(human, request.data.id);
    expect(undone.ok && undone.data.status).toBe("undone");
    const [restored] = await db.select().from(tickets).where(eq(tickets.id, id));
    expect(restored?.status).toBe("OPEN");

    expect(await service.undoRequest(human, request.data.id)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("holds ask-tier actions with a preview, and only humans can approve", async () => {
    const { agent, human } = workspace();
    const id = await createTicket(agent);
    const held = await invoke(agent, "delete_ticket", { ticketId: id, reason: "duplicate" });
    if (!held.ok) throw new Error(held.error);
    expect(held.data.status).toBe("pending");
    expect(held.data.preview?.warnings[0]).toMatch(/can't be undone/);

    expect(await service.approveRequest(agent, held.data.id)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await service.undoRequest(agent, held.data.id)).toMatchObject({ ok: false, code: "FORBIDDEN" });

    const approved = await service.approveRequest(human, held.data.id);
    expect(approved.ok && approved.data.status).toBe("executed");
    expect(await db.select().from(tickets).where(eq(tickets.id, id))).toHaveLength(0);

    expect(await service.approveRequest(human, held.data.id)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("runs an approved action exactly once under concurrent approvals", async () => {
    const { agent, human } = workspace();
    const id = await createTicket(agent);
    const held = await invoke(agent, "delete_ticket", { ticketId: id, reason: "duplicate" });
    if (!held.ok) throw new Error(held.error);

    const results = await Promise.all([1, 2, 3, 4].map(() => service.approveRequest(human, held.data.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const executed = await db.select().from(gatewayEvents).where(eq(gatewayEvents.requestId, held.data.id));
    expect(executed.filter((e) => e.kind === "request.executed")).toHaveLength(1);
  });

  it("refuses to run an approval whose preview no longer matches (what you approve is what runs)", async () => {
    const { agent, human } = workspace();
    const id = await createTicket(agent, "Original title");
    const held = await invoke(agent, "delete_ticket", { ticketId: id, reason: "duplicate" });
    if (!held.ok) throw new Error(held.error);

    await db.update(tickets).set({ title: "Swapped for something important" }).where(eq(tickets.id, id));

    const res = await service.approveRequest(human, held.data.id);
    expect(res).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(await db.select().from(tickets).where(eq(tickets.id, id))).toHaveLength(1);
    const after = await service.getRequest(human, held.data.id);
    expect(after.ok && after.data.status).toBe("expired");
  });

  it("lets the owner change a rule; 'never' hides the tool and blocks calls", async () => {
    const { agent, human } = workspace();
    expect(await service.setActionTier(agent, BUILTIN_TICKETS_ID, "create_ticket", "never")).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    const set = await service.setActionTier(human, BUILTIN_TICKETS_ID, "create_ticket", "never");
    expect(set.ok && set.data.tier).toBe("never");

    const tools = await service.toolCatalogue(agent);
    expect(tools.map((t) => t.name)).not.toContain("tickets__create_ticket");

    const res = await invoke(agent, "create_ticket", { title: "Blocked one", description: "should not exist" });
    expect(res.ok && res.data.status).toBe("denied");
  });

  it("does not allow the undo rule for actions that cannot be undone", async () => {
    const { human } = workspace();
    const res = await service.setActionTier(human, BUILTIN_TICKETS_ID, "delete_ticket", "undo");
    expect(res).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });

  it("keeps workspaces isolated", async () => {
    const a = workspace();
    const b = workspace();
    const id = await createTicket(a.agent);
    const held = await invoke(a.agent, "delete_ticket", { ticketId: id, reason: "dup" });
    if (!held.ok) throw new Error(held.error);
    expect(await service.approveRequest(b.human, held.data.id)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await invoke(b.agent, "delete_ticket", { ticketId: id, reason: "dup" })).toMatchObject({ ok: false });
  });

  it("keeps a verifiable activity chain and detects tampering", async () => {
    const { agent, human, sandboxId } = workspace();
    await createTicket(agent);
    await createTicket(agent, "Second incident");
    await service.setActionTier(human, BUILTIN_TICKETS_ID, "list_tickets", "ask");

    const check = await verifyWorkspaceChain(sandboxId);
    expect(check).toMatchObject({ valid: true });
    expect(check.count).toBeGreaterThanOrEqual(3);

    const [first] = await db.select().from(gatewayEvents).where(eq(gatewayEvents.sandboxId, sandboxId)).limit(1);
    await db.update(gatewayEvents).set({ summary: "Nothing happened here" }).where(eq(gatewayEvents.id, first!.id));
    expect(await verifyWorkspaceChain(sandboxId)).toMatchObject({ valid: false, brokenAtId: first!.id });
  });

  it("builds an overview with today's counts", async () => {
    const { agent, human } = workspace();
    const id = await createTicket(agent);
    await invoke(agent, "delete_ticket", { ticketId: id, reason: "dup" });
    const overview = await service.getOverview(human);
    if (!overview.ok) throw new Error(overview.error);
    expect(overview.data.today.done).toBeGreaterThanOrEqual(1);
    expect(overview.data.today.waiting).toBe(1);
    expect(overview.data.pending[0]?.summary).toBe(`Delete ticket #${id}`);
    expect(overview.data.projects[0]?.name).toMatch(/Incident tickets/);
  });
});
