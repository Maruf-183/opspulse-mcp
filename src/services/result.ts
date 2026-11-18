export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "RATE_LIMITED"
  | "CIRCUIT_BREAKER_OPEN"
  | "INTERNAL";

export type Ok<T> = { ok: true; data: T };
export type Fail = { ok: false; code: ErrorCode; error: string; details?: unknown };
export type ServiceResult<T> = Ok<T> | Fail;

export const ok = <T>(data: T): Ok<T> => ({ ok: true, data });
export const fail = (code: ErrorCode, error: string, details?: unknown): Fail => ({
  ok: false,
  code,
  error,
  ...(details === undefined ? {} : { details }),
});

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  CIRCUIT_BREAKER_OPEN: 429,
  INTERNAL: 500,
};
