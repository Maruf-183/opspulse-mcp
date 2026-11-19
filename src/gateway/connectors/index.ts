// TEMPORARY stand-in. Replaced by the real implementation from the
// gateway-connectors branch at merge time (same exported signature).
import type { Connector, ProjectManifest } from "../types";

export function createConnector(
  manifest: ProjectManifest,
  options: { secret?: string; builtin?: Connector },
): Connector {
  if (manifest.connector.type === "builtin") {
    if (!options.builtin) throw new Error("Built-in project has no connector.");
    return options.builtin;
  }
  throw new Error(`The ${manifest.connector.type} connector is not available yet.`);
}
