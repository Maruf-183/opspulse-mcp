/**
 * OpenAPI connector: any system with a Swagger/OpenAPI 3 description becomes
 * a project with no code. Each operation becomes an action; reads run
 * automatically, writes ask first, deletes are never allowed by default.
 * Calls carry the owner's API credentials (stored encrypted), not OpsPulse
 * signatures, because a third-party API doesn't know OpsPulse.
 */
import { actionDefSchema, type ActionDef, type Connector } from "../types";
import { ConnectorError } from "./http";

type Json = Record<string, unknown>;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_ACTIONS = 60;

/** Blocks obvious internal targets for server-side requests (SSRF). */
export function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(host);
  if (url.protocol !== "https:" || privateHost) {
    throw new ConnectorError("Use a public https address.");
  }
}

function resolve(spec: Json, node: unknown, depth = 0): unknown {
  if (depth > 6 || !node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => resolve(spec, n, depth + 1));
  const obj = node as Json;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/")) {
    const target = obj.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Json)[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), spec);
    return resolve(spec, target, depth + 1);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(spec, v, depth + 1)]));
}

const snake = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const humanize = (value: string) => value.replace(/[_\-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()).trim();

type Param = { name: string; in: string; required?: boolean; schema?: Json; description?: string };

/** Pure conversion: OpenAPI 3 document → actions (with an `http` route each). */
export function actionsFromOpenApi(spec: Json): ActionDef[] {
  if (typeof spec.openapi !== "string" || !String(spec.openapi).startsWith("3")) {
    throw new ConnectorError("Only OpenAPI 3 descriptions (JSON) are supported.");
  }
  const actions: ActionDef[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, Json>)) {
    const shared = ((item.parameters as Param[]) ?? []).map((p) => resolve(spec, p) as Param);
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const params = [...shared, ...(((op.parameters as Param[]) ?? []).map((p) => resolve(spec, p) as Param))].filter(
        (p) => p.in === "path" || p.in === "query",
      );
      const body = resolve(spec, (op.requestBody as Json | undefined)?.content && ((op.requestBody as Json).content as Json)["application/json"]) as Json | undefined;

      const properties: Json = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name] = { ...(p.schema ?? { type: "string" }), ...(p.description ? { description: p.description } : {}) };
        if (p.required || p.in === "path") required.push(p.name);
      }
      if (body?.schema) {
        properties.body = body.schema;
        if ((op.requestBody as Json).required) required.push("body");
      }

      let name = snake(String(op.operationId ?? `${method}_${path}`)).slice(0, 48) || `${method}_op`;
      if (!/^[a-z]/.test(name)) name = `op_${name}`.slice(0, 48);
      while (seen.has(name)) name = `${name.slice(0, 45)}_${seen.size}`;
      seen.add(name);

      const title = String(op.summary ?? humanize(String(op.operationId ?? `${method} ${path}`))).slice(0, 80);
      actions.push(
        actionDefSchema.parse({
          name,
          title: title.length >= 3 ? title : `${method.toUpperCase()} ${path}`.slice(0, 80),
          description: String(op.description ?? "").slice(0, 500),
          tier: method === "get" ? "auto" : method === "delete" ? "never" : "ask",
          summary: `${title}`.slice(0, 200),
          http: { method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, (_, p: string) => `{${p}}`) },
          input: { type: "object", properties, ...(required.length ? { required } : {}) },
        }),
      );
      if (actions.length >= MAX_ACTIONS) return actions;
    }
  }
  if (!actions.length) throw new ConnectorError("No operations were found in this description.");
  return actions;
}

export async function fetchOpenApi(specUrl: string): Promise<Json> {
  assertPublicUrl(specUrl);
  const res = await fetch(specUrl, { signal: AbortSignal.timeout(10_000), redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok) throw new ConnectorError(`Couldn't download the API description (${res.status}).`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new ConnectorError("The API description is too large.");
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new ConnectorError("The API description must be JSON (YAML isn't supported yet).");
  }
}

export function createOpenApiConnector(
  config: { baseUrl: string },
  actions: ActionDef[],
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Connector {
  return {
    async listActions() {
      return actions;
    },
    async execute(action, input) {
      if (!action.http) throw new ConnectorError(`Action "${action.name}" has no route.`);
      assertPublicUrl(config.baseUrl);
      const props = Object.keys(((action.input as Json).properties ?? {}) as Json);
      const path = action.http.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
        if (input[key] === undefined) throw new ConnectorError(`Missing "${key}".`);
        return encodeURIComponent(String(input[key]));
      });
      const url = new URL(config.baseUrl.replace(/\/$/, "") + path);
      for (const key of props) {
        if (key === "body" || action.http.path.includes(`{${key}}`) || input[key] === undefined) continue;
        url.searchParams.set(key, typeof input[key] === "object" ? JSON.stringify(input[key]) : String(input[key]));
      }
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: action.http.method,
          headers: { accept: "application/json", ...(input.body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
          body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch {
        throw new ConnectorError("Couldn't reach the API.");
      }
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text.slice(0, 2000);
      }
      if (!res.ok) throw new ConnectorError(`The API answered with an error (${res.status}).`);
      return { result: json };
    },
  };
}
