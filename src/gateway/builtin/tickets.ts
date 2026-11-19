/**
 * The built-in "Incident tickets" project. It is wired exactly like an
 * external project — a manifest plus a Connector — so the demo exercises the
 * same tier, approval, preview and undo pipeline as any real integration.
 */
import { z } from "zod";
import type { Principal } from "@/lib/authz/policy";
import {
  createTicket,
  deleteTicketForGateway,
  getTicket,
  listTickets,
  restoreTicketFieldsForGateway,
  updateTicket,
} from "@/services/ticket.service";
import { projectManifestSchema, type ActionDef, type Connector, type ProjectManifest } from "../types";

export const BUILTIN_TICKETS_ID = "builtin-tickets";

const STATUS = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;
const PRIORITY = ["LOW", "MEDIUM", "HIGH"] as const;

export const ticketsManifest: ProjectManifest = projectManifestSchema.parse({
  slug: "tickets",
  name: "Incident tickets (demo)",
  description: "A built-in demo project for tracking operational incidents.",
  connector: { type: "builtin" },
  actions: [
    {
      name: "list_tickets",
      title: "See incident tickets",
      description: "Look at the current tickets, optionally filtered by status or priority.",
      tier: "auto",
      summary: "Look at incident tickets",
      input: {
        type: "object",
        properties: {
          status: { type: "string", enum: STATUS },
          priority: { type: "string", enum: PRIORITY },
        },
      },
    },
    {
      name: "create_ticket",
      title: "Create a ticket",
      description: "Open a new incident ticket.",
      tier: "auto",
      undo: true,
      summary: 'Create the ticket "{title}" ({priority} priority)',
      input: {
        type: "object",
        required: ["title", "description"],
        properties: {
          title: { type: "string", minLength: 3, maxLength: 120 },
          description: { type: "string", minLength: 5, maxLength: 1000 },
          priority: { type: "string", enum: PRIORITY, default: "MEDIUM" },
        },
      },
    },
    {
      name: "update_ticket",
      title: "Change a ticket's status or priority",
      description: "Move a ticket forward (e.g. to Resolved) or change how urgent it is.",
      tier: "undo",
      undo: true,
      preview: true,
      summary: "Update ticket #{ticketId}",
      escalate: [{ type: "quiet_hours", from: 22, to: 7, timezone: "Asia/Dhaka" }],
      input: {
        type: "object",
        required: ["ticketId"],
        properties: {
          ticketId: { type: "integer", minimum: 1 },
          status: { type: "string", enum: STATUS },
          priority: { type: "string", enum: PRIORITY },
        },
      },
    },
    {
      name: "delete_ticket",
      title: "Delete a ticket",
      description: "Permanently remove a ticket.",
      tier: "ask",
      preview: true,
      summary: "Delete ticket #{ticketId}",
      input: {
        type: "object",
        required: ["ticketId", "reason"],
        properties: {
          ticketId: { type: "integer", minimum: 1 },
          reason: { type: "string", minLength: 3, maxLength: 300 },
        },
      },
    },
  ],
});

const ticketId = z.object({ ticketId: z.coerce.number().int().positive() });
const undoTokenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), ticketId: z.number() }),
  z.object({
    kind: z.literal("updated"),
    ticketId: z.number(),
    status: z.enum(STATUS),
    priority: z.enum(PRIORITY),
  }),
]);

const label = (value: string) => value.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** `principal` is the agent the gateway is acting for; the workspace is its sandbox. */
export function createTicketsConnector(principal: Principal): Connector {
  const sandboxId = principal.sandboxId;

  async function requireTicket(raw: Record<string, unknown>) {
    const { ticketId: id } = ticketId.parse(raw);
    const found = await getTicket(principal, id);
    if (!found.ok) throw new Error(found.error);
    return found.data;
  }

  return {
    async listActions(): Promise<ActionDef[]> {
      return ticketsManifest.actions;
    },

    async preview(action, input) {
      const ticket = await requireTicket(input);
      if (action.name === "delete_ticket") {
        return {
          changes: [
            { label: "Ticket", before: `#${ticket.id} ${ticket.title}`, after: null },
            { label: "Status", before: label(ticket.status), after: null },
          ],
          warnings: ["This permanently deletes the ticket. It can't be undone."],
        };
      }
      const changes = [];
      if (typeof input.status === "string" && input.status !== ticket.status) {
        changes.push({ label: "Status", before: label(ticket.status), after: label(input.status) });
      }
      if (typeof input.priority === "string" && input.priority !== ticket.priority) {
        changes.push({ label: "Priority", before: label(ticket.priority), after: label(input.priority) });
      }
      return { changes, warnings: [] };
    },

    async execute(action, input) {
      switch (action.name) {
        case "list_tickets": {
          const result = await listTickets(principal, input);
          if (!result.ok) throw new Error(result.error);
          return { result: result.data };
        }
        case "create_ticket": {
          const result = await createTicket(principal, input);
          if (!result.ok) throw new Error(result.error);
          return {
            result: result.data,
            undoToken: JSON.stringify({ kind: "created", ticketId: result.data.id }),
          };
        }
        case "update_ticket": {
          const before = await requireTicket(input);
          const { ticketId: id, ...changes } = input;
          const result = await updateTicket(principal, Number(id), changes);
          if (!result.ok) throw new Error(result.error);
          return {
            result: result.data,
            undoToken: JSON.stringify({
              kind: "updated",
              ticketId: before.id,
              status: before.status,
              priority: before.priority,
            }),
          };
        }
        case "delete_ticket": {
          const { ticketId: id } = ticketId.parse(input);
          const deleted = await deleteTicketForGateway(sandboxId, id);
          if (!deleted) throw new Error(`Ticket #${id} no longer exists.`);
          return { result: { deleted: true, ticketId: id } };
        }
        default:
          throw new Error(`Unknown action ${action.name}`);
      }
    },

    async undo(_action, token) {
      const parsed = undoTokenSchema.parse(JSON.parse(token));
      if (parsed.kind === "created") {
        await deleteTicketForGateway(sandboxId, parsed.ticketId);
        return;
      }
      const restored = await restoreTicketFieldsForGateway(sandboxId, parsed.ticketId, {
        status: parsed.status,
        priority: parsed.priority,
      });
      if (!restored) throw new Error(`Ticket #${parsed.ticketId} no longer exists, so it can't be restored.`);
    },
  };
}
