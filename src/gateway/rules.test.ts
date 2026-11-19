import { describe, expect, it } from "vitest";
import { canonicalJson, decryptSecret, encryptSecret, hashValue } from "./hashing";
import { decideTier, renderSummary } from "./rules";
import { actionDefSchema, type ActionDef } from "./types";

const action = (overrides: Partial<ActionDef> = {}): ActionDef =>
  actionDefSchema.parse({ name: "refund_order", title: "Refund an order", summary: "Refund {amount}", tier: "auto", ...overrides });

const ctx = { now: new Date("2026-11-19T10:00:00Z"), priorExecutions: 3 };

describe("decideTier", () => {
  it("uses the owner override over the manifest default", () => {
    expect(decideTier(action({ tier: "auto" }), "never", {}, ctx).tier).toBe("never");
  });

  it("downgrades undo to ask when the project cannot undo", () => {
    const result = decideTier(action({ undo: false }), "undo", {}, ctx);
    expect(result.tier).toBe("ask");
    expect(result.reasons[0]).toMatch(/can't be undone/);
  });

  it("keeps undo when supported", () => {
    expect(decideTier(action({ undo: true }), "undo", {}, ctx).tier).toBe("undo");
  });

  it("escalates bulk actions with a readable reason", () => {
    const a = action({ escalate: [{ type: "max_items", field: "ids", max: 5 }] });
    const result = decideTier(a, undefined, { ids: Array.from({ length: 50 }, (_, i) => i) }, ctx);
    expect(result.tier).toBe("ask");
    expect(result.reasons[0]).toContain("50");
  });

  it("escalates on numeric amounts too", () => {
    const a = action({ escalate: [{ type: "max_items", field: "amount", max: 5000 }] });
    expect(decideTier(a, undefined, { amount: 12000 }, ctx).tier).toBe("ask");
    expect(decideTier(a, undefined, { amount: 100 }, ctx).tier).toBe("auto");
  });

  it("escalates the first execution only", () => {
    const a = action({ escalate: [{ type: "first_time" }] });
    expect(decideTier(a, undefined, {}, { ...ctx, priorExecutions: 0 }).tier).toBe("ask");
    expect(decideTier(a, undefined, {}, ctx).tier).toBe("auto");
  });

  it("handles quiet hours across midnight in a timezone", () => {
    const a = action({ escalate: [{ type: "quiet_hours", from: 22, to: 7, timezone: "Asia/Dhaka" }] });
    // 20:00 UTC = 02:00 in Dhaka
    expect(decideTier(a, undefined, {}, { ...ctx, now: new Date("2026-11-19T20:00:00Z") }).tier).toBe("ask");
    // 06:00 UTC = 12:00 in Dhaka
    expect(decideTier(a, undefined, {}, { ...ctx, now: new Date("2026-11-19T06:00:00Z") }).tier).toBe("auto");
  });

  it("never relaxes never or ask", () => {
    const a = action({ escalate: [{ type: "first_time" }] });
    expect(decideTier(a, "never", {}, { ...ctx, priorExecutions: 0 }).tier).toBe("never");
  });
});

describe("renderSummary", () => {
  it("fills placeholders and handles arrays and missing values", () => {
    expect(renderSummary('Publish "{title}" ({tags}) by {author}', { title: "AI in 2027", tags: ["a", "b"] })).toBe(
      'Publish "AI in 2027" (2 items) by …',
    );
  });
});

describe("hashing", () => {
  it("hashes objects independently of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it("encrypts secrets with authenticated encryption", () => {
    const ciphertext = encryptSecret("ops_sk_example");
    expect(ciphertext).not.toContain("ops_sk_example");
    expect(decryptSecret(ciphertext)).toBe("ops_sk_example");
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith("A") ? "BB" : "AA");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
