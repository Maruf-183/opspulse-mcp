import { randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env";
import { hmac, safeEqual } from "./crypto";

export const SESSION_COOKIE = "opspulse_sandbox";
/** Header the chat route uses to pass the signed browser session to the MCP server. */
export const SESSION_HEADER = "x-opspulse-session";
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

const SANDBOX_ID_PATTERN = /^sbx_[a-f0-9]{24}$/;

function sessionSecret(): string {
  const env = getEnv();
  // Derived key keeps existing deployments working without a new variable,
  // while keeping cookie signatures independent from the raw MCP key.
  return env.SESSION_SECRET ?? hmac(env.MCP_API_KEY, "opspulse:session-signing:v1");
}

export function newSandboxId(): string {
  return `sbx_${randomBytes(12).toString("hex")}`;
}

/** `sbx_<id>.<signature>` — the client can read it but cannot forge another sandbox. */
export function signSandboxId(sandboxId: string): string {
  return `${sandboxId}.${hmac(sessionSecret(), sandboxId)}`;
}

/** Returns the sandbox ID if the token is well-formed and correctly signed. */
export function verifySessionToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const sandboxId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return null;
  return safeEqual(signature, hmac(sessionSecret(), sandboxId)) ? sandboxId : null;
}

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: SESSION_MAX_AGE_SECONDS,
  path: "/",
});
