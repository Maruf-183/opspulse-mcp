import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** Reads `Authorization: Bearer <token>` and compares it in constant time. */
export function hasBearer(authorization: string | null, expected: string | undefined): boolean {
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  return safeEqual(authorization.slice(7).trim(), expected);
}
