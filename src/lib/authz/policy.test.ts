import { describe, expect, it } from "vitest";
import {
  authorize,
  can,
  ForbiddenError,
  PERMISSIONS,
  permissionsOf,
  ROLES,
  type Principal,
  type Role,
} from "./policy";

const human = (role: Role): Principal => ({ kind: "human", id: "h", role, sandboxId: "sbx" });
const agent = (role: Role): Principal => ({ kind: "agent", id: "a", role, sandboxId: "sbx" });

describe("authorization policy", () => {
  it("never lets an agent decide on requests or change rules, whatever its role", () => {
    for (const role of ROLES) {
      expect(can(agent(role), "request:decide")).toBe(false);
      expect(can(agent(role), "project:manage")).toBe(false);
    }
  });

  it("lets agents ask for actions but not decide on them", () => {
    expect(can(agent("agent"), "project:invoke")).toBe(true);
    expect(can(agent("agent"), "request:decide")).toBe(false);
  });

  it("lets a human operator decide and manage", () => {
    expect(can(human("operator"), "request:decide")).toBe(true);
    expect(can(human("operator"), "project:manage")).toBe(true);
  });

  it("keeps viewers read-only", () => {
    expect(permissionsOf(human("viewer"))).toEqual(["project:read", "audit:read"]);
  });

  it("gives human admins every permission", () => {
    expect(permissionsOf(human("admin"))).toEqual([...PERMISSIONS]);
  });

  it("authorize() throws ForbiddenError when denied", () => {
    expect(() => authorize(human("viewer"), "project:invoke")).toThrow(ForbiddenError);
    expect(() => authorize(human("operator"), "project:invoke")).not.toThrow();
  });
});
