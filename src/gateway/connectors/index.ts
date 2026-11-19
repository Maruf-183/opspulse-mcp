import type { Connector, ProjectManifest } from "../types";
import { createHttpConnector } from "./http";
import { createMcpConnector } from "./mcp";

export { ConnectorError } from "./http";

/** Builds the right connector for a project. Built-in projects pass their own. */
export function createConnector(
  manifest: ProjectManifest,
  options: { secret?: string; builtin?: Connector },
): Connector {
  switch (manifest.connector.type) {
    case "builtin":
      if (!options.builtin) throw new Error("Built-in project has no connector.");
      return options.builtin;
    case "http":
      return createHttpConnector(manifest.connector, manifest.actions);
    case "mcp":
      return createMcpConnector(manifest.connector, manifest.actions);
  }
}
