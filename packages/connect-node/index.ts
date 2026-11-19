/**
 * @opspulse/connect — verify that a request really comes from your OpsPulse
 * gateway. Copy this file into your project (no dependencies besides Node's
 * built-in `crypto`). Works with Next.js route handlers, Express, Hono, Bun.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type OpsPulseMode = "execute" | "preview" | "undo";

export type VerifiedRequest = {
  /** Same id = same action. Never run an id twice (store it). */
  requestId: string;
  mode: OpsPulseMode;
  /** Parsed JSON body (empty object for GET/DELETE). */
  body: Record<string, unknown>;
};

export type VerifyFailure = { ok: false; status: 401; error: string };

const TOLERANCE_SECONDS = 300;

/** Framework-free core. `path` is the request path including the query string. */
export function verifyOpsPulse(input: {
  secret: string;
  method: string;
  path: string;
  rawBody: string;
  headers: { get(name: string): string | null } | Record<string, string | string[] | undefined>;
  now?: number;
}): ({ ok: true } & VerifiedRequest) | VerifyFailure {
  const header = (name: string) => {
    const h = input.headers;
    if (typeof (h as { get?: unknown }).get === "function") return (h as { get(n: string): string | null }).get(name);
    const value = (h as Record<string, string | string[] | undefined>)[name];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
  const deny = (error: string): VerifyFailure => ({ ok: false, status: 401, error });

  const signature = header("x-opspulse-signature");
  const requestId = header("x-opspulse-request-id");
  const mode = header("x-opspulse-mode") as OpsPulseMode | null;
  if (!signature || !requestId || !mode || !["execute", "preview", "undo"].includes(mode)) {
    return deny("Missing OpsPulse headers");
  }

  const parts = Object.fromEntries(signature.split(",").map((kv) => kv.split("=", 2).map((s) => s.trim())));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return deny("Malformed signature");
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > TOLERANCE_SECONDS) return deny("Signature expired");

  const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
  const expected = createHmac("sha256", input.secret)
    .update(`${t}.${requestId}.${input.method.toUpperCase()}.${input.path}.${bodyHash}`)
    .digest();
  const given = Buffer.from(parts.v1!, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return deny("Invalid signature");

  let body: Record<string, unknown> = {};
  if (input.rawBody) {
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      return deny("Body is not JSON");
    }
  }
  return { ok: true, requestId, mode, body };
}

/** For Web `Request` (Next.js route handlers, Hono, Bun, Deno). */
export async function verifyOpsPulseRequest(request: Request, secret: string) {
  const url = new URL(request.url);
  const rawBody = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  return verifyOpsPulse({
    secret,
    method: request.method,
    path: url.pathname + url.search,
    rawBody,
    headers: request.headers,
  });
}

type ExpressLike = {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
  opspulse?: VerifiedRequest;
};

/**
 * Express middleware. Mount it with a raw-body parser so the signature covers
 * the exact bytes, e.g. `app.use(express.text({ type: "*\/*" }))`.
 */
export function opspulseMiddleware(secret: string) {
  return (
    req: ExpressLike & { body?: unknown },
    res: { status(code: number): { json(body: unknown): void } },
    next: () => void,
  ) => {
    const rawBody = typeof req.body === "string" ? req.body : (req.rawBody ?? "");
    const result = verifyOpsPulse({
      secret,
      method: req.method,
      path: req.originalUrl ?? req.url ?? "/",
      rawBody,
      headers: req.headers,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    req.opspulse = { requestId: result.requestId, mode: result.mode, body: result.body };
    next();
  };
}
