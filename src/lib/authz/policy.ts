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
  /** See connected projects, their rules and pending requests. */
  "project:read",
  /** Ask OpsPulse to run an action in a project (subject to its rule). */
  "project:invoke",
  /** Connect or remove projects and change their rules. */
  "project:manage",
  /** Approve, decline or undo requests. */
  "request:decide",
  /** Read the activity log. */
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["viewer", "agent", "operator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  /** Read-only dashboards. */
  viewer: ["project:read", "audit:read"],
  /** AI assistants: may ask for actions, never decide on them or change rules. */
  agent: ["project:read", "project:invoke", "audit:read"],
  /** A human who owns a workspace. */
  operator: ["project:read", "project:invoke", "project:manage", "request:decide", "audit:read"],
  admin: PERMISSIONS,
};

/**
 * Permissions that must only ever be exercised by a human, whatever role an
 * agent is (mis)configured with. This is the server-side half of HITL.
 */
const HUMAN_ONLY: ReadonlySet<Permission> = new Set(["request:decide", "project:manage"]);

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
