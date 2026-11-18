import { afterEach, describe, expect, it, vi } from "vitest";
import { hasBearer, safeEqual } from "./crypto";
import { internalBaseUrl, isAllowedHost, isAllowedOrigin } from "./origins";
import { newSandboxId, signSandboxId, verifySessionToken } from "./session";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signed sandbox sessions", () => {
  it("round-trips a signed sandbox ID", () => {
    const id = newSandboxId();
    expect(verifySessionToken(signSandboxId(id))).toBe(id);
  });

  it("rejects an unsigned or legacy cookie", () => {
    expect(verifySessionToken(newSandboxId())).toBeNull();
    expect(verifySessionToken("sbx_95f974f7bb8f")).toBeNull();
    expect(verifySessionToken("demo-sandbox")).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
  });

  it("rejects a signature copied onto another sandbox ID", () => {
    const [, signature] = signSandboxId(newSandboxId()).split(".");
    expect(verifySessionToken(`${newSandboxId()}.${signature}`)).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    const id = newSandboxId();
    const token = signSandboxId(id);
    vi.stubEnv("SESSION_SECRET", "x".repeat(40));
    vi.resetModules();
    return import("./session").then((fresh) => {
      // getEnv() is cached per module instance, so the fresh module sees the new secret.
      expect(fresh.verifySessionToken(token)).toBeNull();
    });
  });
});

describe("bearer token check", () => {
  it("accepts only the exact token", () => {
    expect(hasBearer("Bearer secret-123", "secret-123")).toBe(true);
    expect(hasBearer("Bearer secret-1234", "secret-123")).toBe(false);
    expect(hasBearer("secret-123", "secret-123")).toBe(false);
    expect(hasBearer(null, "secret-123")).toBe(false);
    expect(hasBearer("Bearer ", undefined)).toBe(false);
  });

  it("compares strings of different lengths safely", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});

describe("origin and host allow-list", () => {
  it("does not accept look-alike origins (substring bypass)", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "opspulse-work.vercel.app");
    expect(isAllowedOrigin("https://opspulse-work.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://opspulse-work.vercel.app.evil.com")).toBe(false);
    expect(isAllowedOrigin("https://localhost.evil.com")).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
  });

  it("allows requests without an Origin header (server-to-server MCP)", () => {
    expect(isAllowedOrigin(null)).toBe(true);
  });

  it("allows localhost only outside production", () => {
    vi.stubEnv("VERCEL_ENV", "development");
    expect(isAllowedHost("localhost:3000")).toBe(true);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isAllowedHost("localhost:3000")).toBe(false);
  });

  it("never builds the internal MCP URL from a forged Host header", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "opspulse-work.vercel.app");
    expect(internalBaseUrl("evil.example")).toBe("https://opspulse-work.vercel.app");
    expect(internalBaseUrl("opspulse-work.vercel.app")).toBe("https://opspulse-work.vercel.app");
  });
});
