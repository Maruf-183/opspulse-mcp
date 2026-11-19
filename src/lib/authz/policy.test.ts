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
  it("never lets an agent approve a deletion, whatever its role", () => {
    for (const role of ROLES) {
      expect(can(agent(role), "ticket:delete:approve")).toBe(false);
    }
  });

  it("lets agents request, but not approve, deletion", () => {
    expect(can(agent("agent"), "ticket:delete:request")).toBe(true);
    expect(can(agent("agent"), "ticket:delete:approve")).toBe(false);
  });

  it("lets a human operator approve deletion", () => {
    expect(can(human("operator"), "ticket:delete:approve")).toBe(true);
  });

  it("keeps viewers read-only", () => {
    expect(permissionsOf(human("viewer"))).toEqual(["ticket:read", "audit:read", "project:read"]);
  });

  it("gives human admins every permission", () => {
    expect(permissionsOf(human("admin"))).toEqual([...PERMISSIONS]);
  });

  it("authorize() throws ForbiddenError when denied", () => {
    expect(() => authorize(human("viewer"), "ticket:create")).toThrow(ForbiddenError);
    expect(() => authorize(human("operator"), "ticket:create")).not.toThrow();
  });
});
