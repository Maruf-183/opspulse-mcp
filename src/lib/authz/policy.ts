/**
 * OpsPulse authorization policy.
 *
 * Every request — from the dashboard, the REST API, or an MCP client — is
 * resolved to a Principal before it reaches the service layer. The service
 * layer then calls `authorize(principal, permission)` before touching the
 * database. Routes never make permission decisions themselves.
 *
 *   UI / REST / MCP  ──►  resolve Principal  ──►  authorize()  ──►  service  ──►  DB
 *
 * To plug in real user authentication later, only the Principal resolution
 * changes (e.g. map an Auth.js session to { kind: "human", role, tenantId }).
 * The roles, permissions and service checks stay the same.
 */

export const PERMISSIONS = [
  "ticket:read",
  "ticket:create",
  "ticket:update",
  "ticket:delete:request",
  "ticket:delete:approve",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["viewer", "agent", "operator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  /** Read-only dashboards. */
  viewer: ["ticket:read", "audit:read"],
  /** AI assistants and MCP clients: may propose a deletion, never approve one. */
  agent: ["ticket:read", "ticket:create", "ticket:update", "ticket:delete:request", "audit:read"],
  /** A human who owns a workspace. */
  operator: [
    "ticket:read",
    "ticket:create",
    "ticket:update",
    "ticket:delete:request",
    "ticket:delete:approve",
    "audit:read",
  ],
  admin: PERMISSIONS,
};

/**
 * Permissions that must only ever be exercised by a human, whatever role an
 * agent is (mis)configured with. This is the server-side half of HITL.
 */
const HUMAN_ONLY: ReadonlySet<Permission> = new Set(["ticket:delete:approve"]);

export type PrincipalKind = "human" | "agent";

export type Principal = {
  kind: PrincipalKind;
  /** Stable identifier used in audit logs, e.g. "browser:sbx_ab12" or "mcp:external". */
  id: string;
  role: Role;
  /** Tenant boundary. Every query is scoped to this value. */
  sandboxId: string;
};

export function can(principal: Principal, permission: Permission): boolean {
  if (HUMAN_ONLY.has(permission) && principal.kind !== "human") return false;
  return ROLE_PERMISSIONS[principal.role].includes(permission);
}

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  constructor(
    readonly principal: Principal,
    readonly permission: Permission,
  ) {
    super(`${principal.kind} with role "${principal.role}" is not allowed to ${permission}.`);
    this.name = "ForbiddenError";
  }
}

export function authorize(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) throw new ForbiddenError(principal, permission);
}

export function permissionsOf(principal: Principal): Permission[] {
  return PERMISSIONS.filter((permission) => can(principal, permission));
}
