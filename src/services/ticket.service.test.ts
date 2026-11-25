import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/authz/policy";

// The service must refuse unauthorized calls *before* any data access. The DB
// mock only supports audit inserts; any other query would throw.
const auditInsert = vi.fn();
vi.mock("@/db", () => ({
  db: {
    insert: () => ({ values: auditInsert }),
    select: () => {
      throw new Error("unexpected read");
    },
    update: () => {
      throw new Error("unexpected update");
    },
    delete: () => {
      throw new Error("unexpected delete");
    },
    batch: () => {
      throw new Error("unexpected batch");
    },
  },
}));

const {
  createTicket,
  createTicketSchema,
  requestDeletionSchema,
  updateTicketSchema,
} = await import("./ticket.service");

const viewer: Principal = { kind: "human", id: "browser:sbx", role: "viewer", sandboxId: "sbx" };

beforeEach(() => auditInsert.mockReset());

describe("service-level authorization", () => {
  it("refuses a viewer creating a ticket", async () => {
    const result = await createTicket(viewer, { title: "Disk full", description: "Root volume at 99%" });
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("input validation", () => {
  it("rejects ticket creation with short title", () => {
    expect(
      createTicketSchema.safeParse({ title: "Hi", description: "Valid description here", priority: "HIGH" })
        .success,
    ).toBe(false);
  });

  it("accepts valid ticket input and defaults priority to MEDIUM", () => {
    const res = createTicketSchema.safeParse({
      title: "Database connection timeout",
      description: "Connection pool exhausted on primary replica.",
    });
    expect(res.success && res.data.priority).toBe("MEDIUM");
  });

  it("rejects deletion request with negative or non-integer ticketId", () => {
    expect(requestDeletionSchema.safeParse({ ticketId: -5, reason: "Duplicate ticket" }).success).toBe(false);
    expect(requestDeletionSchema.safeParse({ ticketId: 1.5, reason: "Duplicate ticket" }).success).toBe(false);
  });

  it("requires at least one field when updating a ticket", () => {
    expect(updateTicketSchema.safeParse({}).success).toBe(false);
    expect(updateTicketSchema.safeParse({ status: "RESOLVED" }).success).toBe(true);
    expect(updateTicketSchema.safeParse({ status: "DONE" }).success).toBe(false);
  });
});
