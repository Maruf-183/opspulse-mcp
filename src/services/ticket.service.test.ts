import { describe, it, expect } from "vitest";
import { createTicketSchema, requestDeletionSchema } from "./ticket.service";

describe("OpsPulse Business Logic & Validation", () => {
  it("rejects ticket creation with short title", () => {
    const res = createTicketSchema.safeParse({
      title: "Hi",
      description: "Valid description here",
      priority: "HIGH",
    });
    expect(res.success).toBe(false);
  });

  it("accepts valid ticket input and defaults priority to MEDIUM", () => {
    const res = createTicketSchema.safeParse({
      title: "Database connection timeout",
      description: "Connection pool exhausted on primary replica.",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.priority).toBe("MEDIUM");
    }
  });

  it("rejects deletion request with negative or non-integer ticketId", () => {
    const res = requestDeletionSchema.safeParse({
      ticketId: -5,
      reason: "Duplicate ticket",
    });
    expect(res.success).toBe(false);
  });
});
