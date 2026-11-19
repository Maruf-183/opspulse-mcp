import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env";
import { hmac } from "@/lib/security/crypto";

/** Deterministic JSON: object keys sorted recursively, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const hashValue = (value: unknown) => sha256(canonicalJson(value));

// ---------------------------------------------------------------------------
// Secret encryption at rest (AES-256-GCM)
// ---------------------------------------------------------------------------

function encryptionKey(): Buffer {
  const env = getEnv();
  const base = env.SESSION_SECRET ?? env.MCP_API_KEY;
  return createHash("sha256").update(hmac(base, "opspulse:secret-encryption:v1")).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(ciphertext: string): string {
  const [version, iv, tag, body] = ciphertext.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export const newProjectSecret = () => `ops_sk_${randomBytes(24).toString("base64url")}`;
