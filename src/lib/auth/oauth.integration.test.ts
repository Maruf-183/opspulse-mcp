import { readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  const client = new PGlite();
  const dir = path.resolve(import.meta.dirname, "../../../drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  return { db: drizzle(client, { schema }) };
});

const oauth = await import("./oauth");
const { upsertGithubUser, safeNext } = await import("./accounts");

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function setup() {
  const user = await upsertGithubUser({ id: Math.floor(Math.random() * 1e9), login: "maruf", name: "Maruf", avatar_url: null });
  const reg = await oauth.registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
  if (!reg.ok) throw new Error("registration failed");
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    response_type: "code" as const,
    client_id: reg.client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: oauth.pkceChallenge(verifier),
    code_challenge_method: "S256" as const,
  };
  const code = await oauth.issueCode(params, user.id);
  const form = (extra: Record<string, string>) =>
    new URLSearchParams({ grant_type: "authorization_code", client_id: reg.client.client_id, redirect_uri: REDIRECT, code, ...extra });
  return { user, client: reg.client, verifier, code, form };
}

describe("OAuth for MCP clients", () => {
  it("rejects insecure or malformed client registrations", async () => {
    expect((await oauth.registerClient({ redirect_uris: ["http://evil.example/cb"] })).ok).toBe(false);
    expect((await oauth.registerClient({ redirect_uris: [] })).ok).toBe(false);
    expect((await oauth.registerClient({ redirect_uris: ["http://localhost:6274/cb"] })).ok).toBe(true);
  });

  it("issues tokens only with the right PKCE verifier, and a code works once", async () => {
    const { form, verifier, user } = await setup();
    expect(await oauth.exchangeToken(form({ code_verifier: "wrong".repeat(10) }))).toMatchObject({ ok: false });
    // The failed attempt above consumed the code: authorization codes are single-use.
    expect(await oauth.exchangeToken(form({ code_verifier: verifier }))).toMatchObject({ ok: false, error: "invalid_grant" });

    const fresh = await setup();
    const ok = await oauth.exchangeToken(fresh.form({ code_verifier: fresh.verifier }));
    if (!ok.ok) throw new Error(ok.description);
    expect(await oauth.verifyAccessToken(ok.body.access_token)).toMatchObject({ userId: fresh.user.id });
    expect(user.id).not.toBe(fresh.user.id);
  });

  it("refuses codes for another client or redirect address", async () => {
    const { form, verifier } = await setup();
    expect(await oauth.exchangeToken(form({ code_verifier: verifier, client_id: "opc_other" }))).toMatchObject({ ok: false });
    const b = await setup();
    expect(await oauth.exchangeToken(b.form({ code_verifier: b.verifier, redirect_uri: "https://claude.ai/other" }))).toMatchObject({
      ok: false,
    });
  });

  it("rotates refresh tokens and revokes the connection when one is reused", async () => {
    const { form, verifier, client, user } = await setup();
    const first = await oauth.exchangeToken(form({ code_verifier: verifier }));
    if (!first.ok) throw new Error(first.description);
    const refresh = (token: string) =>
      oauth.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: token }));

    const second = await refresh(first.body.refresh_token);
    if (!second.ok) throw new Error(second.description);
    expect(await oauth.verifyAccessToken(second.body.access_token)).not.toBeNull();

    // Replaying the old refresh token = leak → everything in the connection dies.
    expect(await refresh(first.body.refresh_token)).toMatchObject({ ok: false });
    expect(await oauth.verifyAccessToken(second.body.access_token)).toBeNull();
    expect(await oauth.listConnections(user.id)).toHaveLength(0);
  });

  it("lists and disconnects apps", async () => {
    const { form, verifier, user } = await setup();
    const tokens = await oauth.exchangeToken(form({ code_verifier: verifier }));
    if (!tokens.ok) throw new Error(tokens.description);
    const [connection] = await oauth.listConnections(user.id);
    expect(connection).toMatchObject({ app: "Claude" });
    expect(await oauth.revokeGrant(user.id, connection!.grantId)).toBe(true);
    expect(await oauth.verifyAccessToken(tokens.body.access_token)).toBeNull();
  });

  it("only redirects to same-site paths after sign-in", () => {
    expect(safeNext("/oauth/authorize?x=1")).toBe("/oauth/authorize?x=1");
    expect(safeNext("https://evil.example")).toBe("/dashboard");
    expect(safeNext("//evil.example")).toBe("/dashboard");
    expect(safeNext("/\\evil.example")).toBe("/dashboard");
  });
});
