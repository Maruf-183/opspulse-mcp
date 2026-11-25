/**
 * Built-in "Sample notes" project. Lets anyone try OpsPulse before connecting
 * a real system. It is wired exactly like an external project (manifest +
 * connector), so it exercises the same rules, previews, approvals and undo.
 */
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { sampleNotes } from "@/db/schema";
import type { Principal } from "@/lib/authz/policy";
import { projectManifestSchema, type Connector, type ProjectManifest } from "../types";

export const BUILTIN_NOTES_ID = "builtin-notes";

export const notesManifest: ProjectManifest = projectManifestSchema.parse({
  slug: "sample-notes",
  name: "Sample notes",
  description: "A small notebook to try OpsPulse before you connect your own systems.",
  connector: { type: "builtin" },
  actions: [
    {
      name: "list_notes",
      title: "Read notes",
      description: "See your notes, or search them.",
      tier: "auto",
      summary: "Read notes",
      input: { type: "object", properties: { search: { type: "string", maxLength: 100 } } },
    },
    {
      name: "add_note",
      title: "Add a note",
      description: "Write a new note.",
      tier: "undo",
      undo: true,
      summary: 'Add the note "{title}"',
      input: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", minLength: 1, maxLength: 120 }, body: { type: "string", maxLength: 5000 } },
      },
    },
    {
      name: "edit_note",
      title: "Edit a note",
      description: "Change a note's title or text.",
      tier: "undo",
      undo: true,
      preview: true,
      summary: "Edit note #{noteId}",
      input: {
        type: "object",
        required: ["noteId"],
        properties: {
          noteId: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1, maxLength: 120 },
          body: { type: "string", maxLength: 5000 },
        },
      },
    },
    {
      name: "delete_note",
      title: "Delete a note",
      description: "Remove a note.",
      tier: "ask",
      undo: true,
      preview: true,
      summary: "Delete note #{noteId}",
      input: { type: "object", required: ["noteId"], properties: { noteId: { type: "integer", minimum: 1 } } },
    },
  ],
});

const noteId = z.object({ noteId: z.coerce.number().int().positive() });
const snapshot = z.object({ id: z.number(), title: z.string(), body: z.string(), createdAt: z.string() });
const undoToken = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), id: z.number() }),
  z.object({ kind: z.literal("edited"), id: z.number(), title: z.string(), body: z.string() }),
  z.object({ kind: z.literal("deleted"), note: snapshot }),
]);

const short = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}…` : text);

export function createNotesConnector(principal: Principal): Connector {
  const sandboxId = principal.sandboxId;

  async function find(id: number) {
    const [note] = await db.select().from(sampleNotes).where(and(eq(sampleNotes.id, id), eq(sampleNotes.sandboxId, sandboxId)));
    if (!note) throw new Error(`Note #${id} doesn't exist.`);
    return note;
  }

  return {
    async listActions() {
      return notesManifest.actions;
    },

    async preview(action, input) {
      const note = await find(noteId.parse(input).noteId);
      if (action.name === "delete_note") {
        return { changes: [{ label: "Note", before: note.title, after: null }], warnings: [] };
      }
      const changes = [];
      if (typeof input.title === "string" && input.title !== note.title) changes.push({ label: "Title", before: note.title, after: input.title });
      if (typeof input.body === "string" && input.body !== note.body) changes.push({ label: "Text", before: short(note.body), after: short(input.body) });
      return { changes, warnings: [] };
    },

    async execute(action, input) {
      switch (action.name) {
        case "list_notes": {
          const search = typeof input.search === "string" && input.search.trim() ? `%${input.search.trim()}%` : null;
          const rows = await db
            .select()
            .from(sampleNotes)
            .where(
              search
                ? and(eq(sampleNotes.sandboxId, sandboxId), or(ilike(sampleNotes.title, search), ilike(sampleNotes.body, search)))
                : eq(sampleNotes.sandboxId, sandboxId),
            )
            .orderBy(desc(sampleNotes.updatedAt))
            .limit(50);
          return { result: rows.map((n) => ({ id: n.id, title: n.title, text: n.body, updated: n.updatedAt })) };
        }
        case "add_note": {
          const [note] = await db
            .insert(sampleNotes)
            .values({ sandboxId, title: String(input.title), body: typeof input.body === "string" ? input.body : "" })
            .returning();
          return { result: { id: note!.id, title: note!.title }, undoToken: JSON.stringify({ kind: "added", id: note!.id }) };
        }
        case "edit_note": {
          const before = await find(noteId.parse(input).noteId);
          const changes: { title?: string; body?: string; updatedAt: Date } = { updatedAt: new Date() };
          if (typeof input.title === "string") changes.title = input.title;
          if (typeof input.body === "string") changes.body = input.body;
          await db.update(sampleNotes).set(changes).where(eq(sampleNotes.id, before.id));
          return {
            result: { id: before.id, updated: true },
            undoToken: JSON.stringify({ kind: "edited", id: before.id, title: before.title, body: before.body }),
          };
        }
        case "delete_note": {
          const note = await find(noteId.parse(input).noteId);
          await db.delete(sampleNotes).where(eq(sampleNotes.id, note.id));
          return {
            result: { id: note.id, deleted: true },
            undoToken: JSON.stringify({ kind: "deleted", note: { id: note.id, title: note.title, body: note.body, createdAt: note.createdAt.toISOString() } }),
          };
        }
        default:
          throw new Error(`Unknown action ${action.name}`);
      }
    },

    async undo(_action, token) {
      const parsed = undoToken.parse(JSON.parse(token));
      if (parsed.kind === "added") {
        await db.delete(sampleNotes).where(and(eq(sampleNotes.id, parsed.id), eq(sampleNotes.sandboxId, sandboxId)));
      } else if (parsed.kind === "edited") {
        await db
          .update(sampleNotes)
          .set({ title: parsed.title, body: parsed.body, updatedAt: new Date() })
          .where(and(eq(sampleNotes.id, parsed.id), eq(sampleNotes.sandboxId, sandboxId)));
      } else {
        await db.insert(sampleNotes).values({
          id: parsed.note.id,
          sandboxId,
          title: parsed.note.title,
          body: parsed.note.body,
          createdAt: new Date(parsed.note.createdAt),
        });
      }
    },
  };
}
