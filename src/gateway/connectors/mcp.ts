/**
 * MCP connector: puts OpsPulse rules in front of ANY existing MCP server,
 * without changing that server. Tools are discovered with tools/list and
 * turned into actions; the owner's manifest can override any of them by name.
 */
import { createMCPClient } from "@ai-sdk/mcp";
import { actionDefSchema, type ActionDef, type Connector, type Tier } from "../types";
import { ConnectorError } from "./http";

type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
};

/** "github.create-issue" → "github_create_issue" (MCP names allow characters ours don't). */
export function toActionName(name: string): string {
  const cleaned = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z]/.test(cleaned) ? cleaned : `t_${cleaned}`;
  return prefixed.slice(0, 48).padEnd(2, "_");
}

const humanize = (name: string) =>
  name
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());

/** Safe defaults from the server's own hints: reads run, writes ask. */
export function defaultTier(tool: McpTool): Tier {
  if (tool.annotations?.readOnlyHint) return "auto";
  return "ask";
}

export function toActionDef(tool: McpTool, override?: ActionDef): ActionDef {
  const title = (tool.title ?? tool.annotations?.title ?? humanize(tool.name)).slice(0, 80);
  const discovered = actionDefSchema.parse({
    name: toActionName(tool.name),
    title: title.length >= 3 ? title : `Run ${title}`,
    description: (tool.description ?? "").slice(0, 500),
    input: tool.inputSchema ?? { type: "object", properties: {} },
    tier: defaultTier(tool),
    summary: `Run "${title}"`.slice(0, 200),
  });
  // The owner's manifest wins for wording, tier and escalation; the schema
  // always comes from the server so it can't drift from what it accepts.
  return override ? { ...discovered, ...override, input: discovered.input, undo: false, preview: false } : discovered;
}

export function createMcpConnector(
  config: { url: string; headers: Record<string, string> },
  overrides: ActionDef[] = [],
): Connector {
  const byName = new Map(overrides.map((a) => [a.name, a]));
  let originalNames: Map<string, string> | undefined;

  async function withClient<T>(fn: (client: Awaited<ReturnType<typeof createMCPClient>>) => Promise<T>): Promise<T> {
    let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
    try {
      client = await createMCPClient({ transport: { type: "http", url: config.url, headers: config.headers } });
      return await fn(client);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(`The connected MCP server didn't respond as expected: ${(error as Error)?.message ?? "unknown error"}`.slice(0, 200));
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async function discover(): Promise<ActionDef[]> {
    return withClient(async (client) => {
      const { tools } = await client.listTools();
      originalNames = new Map();
      return (tools as McpTool[]).map((tool) => {
        const action = toActionDef(tool, byName.get(toActionName(tool.name)));
        originalNames!.set(action.name, tool.name);
        return action;
      });
    });
  }

  return {
    listActions: discover,
    async execute(action, input) {
      if (!originalNames) await discover();
      const name = originalNames?.get(action.name);
      if (!name) throw new ConnectorError(`The MCP server no longer offers "${action.title}".`);
      return withClient(async (client) => {
        const result = await client.callTool({ name, arguments: input });
        if (result.isError) {
          const text = Array.isArray(result.content)
            ? result.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join(" ")
            : "";
          throw new ConnectorError((text || "The tool reported an error.").slice(0, 200));
        }
        return { result: "structuredContent" in result && result.structuredContent ? result.structuredContent : result.content };
      });
    },
  };
}
