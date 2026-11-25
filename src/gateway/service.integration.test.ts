/**
 * End-to-end tests of the gateway pipeline against a real Postgres (PGlite,
 * in-process) using the same SQL migrations that production runs, through the
 * built-in Sample notes project.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
const { gatewayEvents, sampleNotes } = await import("@/db/schema");
const service = await import("./service");
const { verifyWorkspaceChain } = await import("./events");
const { BUILTIN_NOTES_ID } = await import("./builtin/notes");
const { eq } = await import("drizzle-orm");

let n = 0;
function workspace() {
  const sandboxId = `sbx_${(++n).toString(16).padStart(24, "0")}`;
  const human: Principal = { kind: "human", id: `browser:${sandboxId}`, role: "operator", sandboxId };
  const agent: Principal = { kind: "agent", id: `assistant:${sandboxId}`, role: "agent", sandboxId };
  return { sandboxId, human, agent };
}

const invoke = (p: Principal, action: string, input: unknown) => service.invokeAction(p, BUILTIN_NOTES_ID, action, input);

async function addNote(p: Principal, title = "Team lunch on Friday") {
  const res = await invoke(p, "add_note", { title, body: "Book a table for 8" });
  if (!res.ok) throw new Error(res.error);
  return (res.data.result as { id: number }).id;
}

const noteOf = async (id: number) => (await db.select().from(sampleNotes).where(eq(sampleNotes.id, id)))[0];

describe("gateway pipeline", () => {
  it("runs automatic actions immediately", async () => {
    const { agent } = workspace();
    await addNote(agent);
    const res = await invoke(agent, "list_notes", {});
    expect(res.ok && res.data.status).toBe("executed");
    expect(res.ok && (res.data.result as unknown[]).length).toBe(1);
  });

  it("rejects input that does not match the action", async () => {
    const { agent } = workspace();
    expect(await invoke(agent, "add_note", { body: "no title" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });

  it("runs undo-rule actions and lets a person reverse them, once", async () => {
    const { agent, human } = workspace();
    const id = await addNote(agent, "Old title");
    const res = await invoke(agent, "edit_note", { noteId: id, title: "New title" });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.status).toBe("executed");
    expect(res.data.undoUntil).not.toBeNull();
    expect((await noteOf(id))?.title).toBe("New title");

    expect(await service.undoRequest(agent, res.data.id)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const undone = await service.undoRequest(human, res.data.id);
    expect(undone.ok && undone.data.status).toBe("undone");
    expect((await noteOf(id))?.title).toBe("Old title");
    expect(await service.undoRequest(human, res.data.id)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("holds ask-first actions with a preview, and only people can approve", async () => {
    const { agent, human } = workspace();
    const id = await addNote(agent, "Quarterly plan");
    const held = await invoke(agent, "delete_note", { noteId: id });
    if (!held.ok) throw new Error(held.error);
    expect(held.data.status).toBe("pending");
    expect(held.data.preview?.changes[0]).toMatchObject({ before: "Quarterly plan", after: null });

    expect(await service.approveRequest(agent, held.data.id)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const approved = await service.approveRequest(human, held.data.id);
    expect(approved.ok && approved.data.status).toBe("executed");
    expect(await noteOf(id)).toBeUndefined();
    expect(await service.approveRequest(human, held.data.id)).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("can bring a deleted note back with undo", async () => {
    const { agent, human } = workspace();
    const id = await addNote(agent, "Keep me");
    const held = await invoke(agent, "delete_note", { noteId: id });
    if (!held.ok) throw new Error(held.error);
    const approved = await service.approveRequest(human, held.data.id);
    if (!approved.ok) throw new Error(approved.error);
    await service.undoRequest(human, held.data.id);
    expect((await noteOf(id))?.title).toBe("Keep me");
  });

  it("runs an approved action exactly once under concurrent approvals", async () => {
    const { agent, human } = workspace();
    const id = await addNote(agent);
    const held = await invoke(agent, "delete_note", { noteId: id });
    if (!held.ok) throw new Error(held.error);
    const results = await Promise.all([1, 2, 3, 4].map(() => service.approveRequest(human, held.data.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const events = await db.select().from(gatewayEvents).where(eq(gatewayEvents.requestId, held.data.id));
    expect(events.filter((e) => e.kind === "request.executed")).toHaveLength(1);
  });

  it("refuses an approval whose preview no longer matches (what you approve is what runs)", async () => {
    const { agent, human } = workspace();
    const id = await addNote(agent, "Original");
    const held = await invoke(agent, "delete_note", { noteId: id });
    if (!held.ok) throw new Error(held.error);
    await db.update(sampleNotes).set({ title: "Something important" }).where(eq(sampleNotes.id, id));

    expect(await service.approveRequest(human, held.data.id)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(await noteOf(id)).toBeDefined();
    const after = await service.getRequest(human, held.data.id);
    expect(after.ok && after.data.status).toBe("expired");
  });

  it("lets the owner change a rule; 'never' hides the action and blocks calls", async () => {
    const { agent, human } = workspace();
    expect(await service.setActionTier(agent, BUILTIN_NOTES_ID, "add_note", "never")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const set = await service.setActionTier(human, BUILTIN_NOTES_ID, "add_note", "never");
    expect(set.ok && set.data.tier).toBe("never");
    expect((await service.toolCatalogue(agent)).map((t) => t.action.name)).not.toContain("add_note");
    const res = await invoke(agent, "add_note", { title: "Blocked" });
    expect(res.ok && res.data.status).toBe("denied");
  });

  it("does not allow the undo rule for actions that can't be undone", async () => {
    const { human } = workspace();
    expect(await service.setActionTier(human, BUILTIN_NOTES_ID, "list_notes", "undo")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });

  it("keeps workspaces apart", async () => {
    const a = workspace();
    const b = workspace();
    const id = await addNote(a.agent);
    const held = await invoke(a.agent, "delete_note", { noteId: id });
    if (!held.ok) throw new Error(held.error);
    expect(await service.approveRequest(b.human, held.data.id)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await invoke(b.agent, "delete_note", { noteId: id })).toMatchObject({ ok: false });
  });

  it("keeps a verifiable activity log and detects tampering", async () => {
    const { agent, human, sandboxId } = workspace();
    await addNote(agent);
    await addNote(agent, "Second");
    await service.setActionTier(human, BUILTIN_NOTES_ID, "list_notes", "ask");
    const check = await verifyWorkspaceChain(sandboxId);
    expect(check).toMatchObject({ valid: true });
    expect(check.count).toBeGreaterThanOrEqual(3);

    const [first] = await db.select().from(gatewayEvents).where(eq(gatewayEvents.sandboxId, sandboxId)).limit(1);
    await db.update(gatewayEvents).set({ summary: "Nothing happened here" }).where(eq(gatewayEvents.id, first!.id));
    expect(await verifyWorkspaceChain(sandboxId)).toMatchObject({ valid: false, brokenAtId: first!.id });
  });

  it("builds an overview with today's counts", async () => {
    const { agent, human } = workspace();
    const id = await addNote(agent);
    await invoke(agent, "delete_note", { noteId: id });
    const overview = await service.getOverview(human);
    if (!overview.ok) throw new Error(overview.error);
    expect(overview.data.today.done).toBeGreaterThanOrEqual(1);
    expect(overview.data.today.waiting).toBe(1);
    expect(overview.data.pending[0]?.summary).toBe(`Delete note #${id}`);
    expect(overview.data.projects[0]?.name).toBe("Sample notes");
  });
});
