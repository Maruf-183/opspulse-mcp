/**
 * HTTP connector: calls any web API (any language) that implements the small
 * OpsPulse protocol documented in `../types.ts`.
 */
import { sign } from "../signing";
import {
  MODE_HEADER,
  REQUEST_ID_HEADER,
  UNDO_PATH,
  SIGNATURE_HEADER,
  executeResponseSchema,
  previewResponseSchema,
  type ActionDef,
  type Connector,
  type ConnectorContext,
  type ConnectorMode,
} from "../types";

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

const TIMEOUT_MS = 15_000;

/** Fills `{field}` placeholders; returns the path and the fields not consumed. */
export function buildPath(template: string, input: Record<string, unknown>) {
  const rest = { ...input };
  const path = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = rest[key];
    if (value === undefined || value === null) throw new ConnectorError(`Missing "${key}" for this action.`);
    delete rest[key];
    return encodeURIComponent(String(value));
  });
  return { path, rest };
}

export function createHttpConnector(
  config: { baseUrl: string },
  actions: ActionDef[],
  fetchImpl: typeof fetch = fetch,
): Connector {
  const base = new URL(config.baseUrl);

  async function call(
    action: ActionDef,
    mode: ConnectorMode,
    payload: Record<string, unknown>,
    ctx: ConnectorContext,
  ): Promise<unknown> {
    if (!action.http) throw new ConnectorError(`Action "${action.name}" has no HTTP route.`);
    if (!ctx.secret) throw new ConnectorError("This project has no signing secret.");

    // Undo goes to one fixed endpoint, since the token carries everything the project needs.
    const method = mode === "undo" ? "POST" : action.http.method;
    const { path: filled, rest } =
      mode === "undo" ? { path: UNDO_PATH, rest: { action: action.name, ...payload } } : buildPath(action.http.path, payload);
    const url = new URL(base.pathname.replace(/\/$/, "") + filled, base);
    let body = "";
    if (method === "GET" || method === "DELETE") {
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    } else {
      body = JSON.stringify(rest);
    }
    const signedPath = url.pathname + url.search;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [REQUEST_ID_HEADER]: ctx.requestId,
          [MODE_HEADER]: mode,
          [SIGNATURE_HEADER]: sign(ctx.secret, { requestId: ctx.requestId, method, path: signedPath, body }),
        },
        body: body || undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ConnectorError(timedOut ? "The project took too long to respond." : "Couldn't reach the project.");
    }

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const message =
        json && typeof json === "object" && "error" in json && typeof json.error === "string"
          ? json.error.slice(0, 200)
          : `The project answered with an error (${response.status}).`;
      throw new ConnectorError(message, response.status);
    }
    return json;
  }

  return {
    async listActions() {
      return actions;
    },
    async execute(action, input, ctx) {
      const parsed = executeResponseSchema.safeParse((await call(action, "execute", input, ctx)) ?? {});
      if (!parsed.success) throw new ConnectorError("The project sent a response OpsPulse couldn't read.");
      return parsed.data;
    },
    async preview(action, input, ctx) {
      if (!action.preview) return { changes: [], warnings: [] };
      const parsed = previewResponseSchema.safeParse((await call(action, "preview", input, ctx)) ?? {});
      if (!parsed.success) throw new ConnectorError("The project sent a preview OpsPulse couldn't read.");
      return parsed.data;
    },
    async undo(action, undoToken, ctx) {
      if (!action.undo) throw new ConnectorError("This action can't be undone.");
      await call(action, "undo", { undoToken }, ctx);
    },
  };
}
