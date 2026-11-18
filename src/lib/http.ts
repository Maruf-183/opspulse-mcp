import { NextRequest, NextResponse } from "next/server";
import { ForbiddenError, type Principal } from "@/lib/authz/policy";
import { isAllowedOrigin } from "@/lib/security/origins";
import {
  SESSION_COOKIE,
  newSandboxId,
  sessionCookieOptions,
  signSandboxId,
  verifySessionToken,
} from "@/lib/security/session";
import { HTTP_STATUS, type ErrorCode, type ServiceResult } from "@/services/result";

/** Error body shape shared by every route: `{ error, code, details? }`. */
export function errorResponse(code: ErrorCode, message: string, details?: unknown) {
  return NextResponse.json(
    { error: message, code, ...(details === undefined ? {} : { details }) },
    { status: HTTP_STATUS[code] },
  );
}

export function toResponse<T>(result: ServiceResult<T>, successStatus = 200) {
  if (!result.ok) return errorResponse(result.code, result.error, result.details);
  return NextResponse.json({ data: result.data }, { status: successStatus });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** The dashboard user is the human operator of their own sandbox. */
export function browserPrincipal(sandboxId: string): Principal {
  return { kind: "human", id: `browser:${sandboxId}`, role: "operator", sandboxId };
}

export function getSandboxFromCookie(req: NextRequest): string | null {
  return verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
}

export function setSessionCookie(res: NextResponse, sandboxId: string) {
  res.cookies.set(SESSION_COOKIE, signSandboxId(sandboxId), sessionCookieOptions());
}

/** Returns the signed session, issuing a new sandbox when there is none. */
export function getOrCreateSandbox(req: NextRequest) {
  const existing = getSandboxFromCookie(req);
  return existing ? { sandboxId: existing, isNew: false } : { sandboxId: newSandboxId(), isNew: true };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Wraps a browser-facing route: rejects cross-site writes, requires a signed
 * session, and maps authorization failures to 403. Handlers receive an
 * already-resolved Principal and pass it to the service layer.
 */
export async function withBrowserPrincipal(
  req: NextRequest,
  handler: (principal: Principal) => Promise<Response>,
): Promise<Response> {
  if (!SAFE_METHODS.has(req.method) && !isAllowedOrigin(req.headers.get("origin"))) {
    return errorResponse("FORBIDDEN", "Cross-origin request rejected.");
  }
  const sandboxId = getSandboxFromCookie(req);
  if (!sandboxId) {
    return errorResponse("UNAUTHENTICATED", "No valid workspace session. Reload the dashboard.");
  }
  try {
    return await handler(browserPrincipal(sandboxId));
  } catch (error) {
    return handleRouteError(error);
  }
}

export function handleRouteError(error: unknown) {
  if (error instanceof ForbiddenError) return errorResponse("FORBIDDEN", error.message);
  console.error("Unhandled route error:", error);
  return errorResponse("INTERNAL", "Something went wrong. Please try again.");
}

export function parseId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}
