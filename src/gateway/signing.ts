/**
 * Request signing between OpsPulse and a connected project — the same idea
 * as Stripe/GitHub webhook signatures, plus a request id for idempotency.
 *
 *   x-opspulse-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${requestId}.${METHOD}.${path}.${sha256(body)}`)>
 *
 * Pure functions with an injectable clock; no framework dependencies.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SIGNATURE_TOLERANCE_SECONDS } from "./types";

const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex");

export function signaturePayload(t: number, requestId: string, method: string, path: string, body: string): string {
  return `${t}.${requestId}.${method.toUpperCase()}.${path}.${bodyHash(body)}`;
}

export function sign(
  secret: string,
  parts: { requestId: string; method: string; path: string; body: string },
  now: () => number = Date.now,
): string {
  const t = Math.floor(now() / 1000);
  const v1 = createHmac("sha256", secret)
    .update(signaturePayload(t, parts.requestId, parts.method, parts.path, parts.body))
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "stale" | "mismatch" };

export function verify(
  secret: string,
  header: string | null | undefined,
  parts: { requestId: string; method: string; path: string; body: string },
  now: () => number = Date.now,
): VerifyResult {
  if (!header) return { ok: false, reason: "malformed" };
  const fields = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(fields.t);
  const v1 = fields.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(now() / 1000) - t) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };

  const expected = createHmac("sha256", secret)
    .update(signaturePayload(t, parts.requestId, parts.method, parts.path, parts.body))
    .digest();
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}
