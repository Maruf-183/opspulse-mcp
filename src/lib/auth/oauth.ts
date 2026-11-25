/**
 * OAuth 2.1 authorization server for MCP clients (claude.ai, ChatGPT, …):
 * dynamic client registration, authorization code + PKCE (S256 only),
 * short-lived access tokens, rotating refresh tokens with reuse detection.
 * Tokens and codes are stored only as SHA-256 hashes.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { oauthClients, oauthCodes, oauthTokens } from "@/db/schema";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

// ---------------------------------------------------------------------------
// Client registration (RFC 7591)
// ---------------------------------------------------------------------------

const redirectUri = z.url().refine((uri) => {
  const u = new URL(uri);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return u.protocol === "https:" || (u.protocol === "http:" && local);
}, "Redirect URIs must use https (or http on localhost)");

export const registrationSchema = z.object({
  client_name: z.string().min(1).max(100).default("AI app"),
  redirect_uris: z.array(redirectUri).min(1).max(10),
});

export async function registerClient(raw: unknown) {
  const parsed = registrationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "invalid_client_metadata", detail: z.flattenError(parsed.error) };
  const clientId = `opc_${randomUUID()}`;
  await db.insert(oauthClients).values({
    clientId,
    clientName: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
  });
  return {
    ok: true as const,
    client: {
      client_id: clientId,
      client_name: parsed.data.client_name,
      redirect_uris: parsed.data.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

export async function getClient(clientId: string) {
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return client ? { ...client, redirectUris: client.redirectUris as string[] } : null;
}

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

export const authorizeParamsSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(500).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
});
export type AuthorizeParams = z.infer<typeof authorizeParamsSchema>;

export async function issueCode(params: AuthorizeParams, userId: string): Promise<string> {
  const code = token("opcode");
  await db.insert(oauthCodes).values({
    codeHash: hash(code),
    clientId: params.client_id,
    userId,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

type TokenError = { ok: false; error: "invalid_request" | "invalid_grant" | "invalid_client" | "unsupported_grant_type"; description: string };
type TokenSuccess = {
  ok: true;
  body: { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string };
};

async function mintPair(grantId: string, clientId: string, userId: string): Promise<TokenSuccess> {
  const access = token("opat");
  const refresh = token("oprt");
  await db.insert(oauthTokens).values([
    { tokenHash: hash(access), kind: "access", grantId, clientId, userId, expiresAt: new Date(Date.now() + ACCESS_TTL_MS) },
    { tokenHash: hash(refresh), kind: "refresh", grantId, clientId, userId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  ]);
  return {
    ok: true,
    body: { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh },
  };
}

export async function exchangeToken(form: URLSearchParams): Promise<TokenSuccess | TokenError> {
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    // Claim the code atomically: a code can be exchanged once.
    const [claimed] = await db
      .update(oauthCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthCodes.codeHash, hash(code)), isNull(oauthCodes.usedAt)))
      .returning();
    if (!claimed) return { ok: false, error: "invalid_grant", description: "Unknown or already used code" };
    if (claimed.expiresAt < new Date()) return { ok: false, error: "invalid_grant", description: "Code expired" };
    if (claimed.clientId !== clientId) return { ok: false, error: "invalid_grant", description: "Code was issued to another client" };
    if (claimed.redirectUri !== form.get("redirect_uri")) return { ok: false, error: "invalid_grant", description: "redirect_uri mismatch" };
    if (!verifier || pkceChallenge(verifier) !== claimed.codeChallenge) {
      return { ok: false, error: "invalid_grant", description: "PKCE verification failed" };
    }
    return mintPair(randomUUID(), clientId, claimed.userId);
  }

  if (grantType === "refresh_token") {
    const presented = hash(form.get("refresh_token") ?? "");
    const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, presented));
    if (!row || row.kind !== "refresh" || row.revokedAt || row.expiresAt < new Date()) {
      return { ok: false, error: "invalid_grant", description: "Invalid refresh token" };
    }
    if (row.clientId !== clientId) return { ok: false, error: "invalid_grant", description: "Token belongs to another client" };
    // Rotation with reuse detection: a refresh token works once. Seeing it
    // again means it leaked, so the whole connection is revoked.
    const [rotated] = await db
      .update(oauthTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthTokens.tokenHash, presented), isNull(oauthTokens.usedAt)))
      .returning();
    if (!rotated) {
      await revokeGrant(row.userId, row.grantId);
      return { ok: false, error: "invalid_grant", description: "Refresh token reused; connection revoked" };
    }
    return mintPair(row.grantId, clientId, row.userId);
  }

  return { ok: false, error: "unsupported_grant_type", description: "Use authorization_code or refresh_token" };
}

/** Returns the user behind a valid, unexpired, unrevoked access token. */
export async function verifyAccessToken(accessToken: string) {
  if (!accessToken.startsWith("opat_")) return null;
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash(accessToken)));
  if (!row || row.kind !== "access" || row.revokedAt || row.expiresAt < new Date()) return null;
  return { userId: row.userId, clientId: row.clientId, grantId: row.grantId };
}

export async function revokeGrant(userId: string, grantId: string) {
  const revoked = await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)))
    .returning({ tokenHash: oauthTokens.tokenHash });
  return revoked.length > 0;
}

/** Active connections for the dashboard: one per grant, newest first. */
export async function listConnections(userId: string) {
  const rows = await db
    .select({
      grantId: oauthTokens.grantId,
      clientId: oauthTokens.clientId,
      createdAt: oauthTokens.createdAt,
      revokedAt: oauthTokens.revokedAt,
      expiresAt: oauthTokens.expiresAt,
      kind: oauthTokens.kind,
      clientName: oauthClients.clientName,
    })
    .from(oauthTokens)
    .leftJoin(oauthClients, eq(oauthClients.clientId, oauthTokens.clientId))
    .where(eq(oauthTokens.userId, userId));
  const now = new Date();
  const grants = new Map<string, { grantId: string; app: string; connectedAt: Date }>();
  for (const row of rows) {
    if (row.kind !== "refresh" || row.revokedAt || row.expiresAt < now) continue;
    const existing = grants.get(row.grantId);
    if (!existing || row.createdAt < existing.connectedAt) {
      grants.set(row.grantId, { grantId: row.grantId, app: row.clientName ?? "AI app", connectedAt: row.createdAt });
    }
  }
  return [...grants.values()].sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
}
