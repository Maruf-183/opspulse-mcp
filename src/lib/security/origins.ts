import { isProduction } from "@/lib/env";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Hosts this deployment is allowed to be reached on. Built from configuration,
 * never from request headers.
 */
export function allowedHosts(): Set<string> {
  const hosts = [
    process.env.APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
  ]
    .map(hostOf)
    .filter((host): host is string => Boolean(host));
  return new Set(hosts);
}

function isLocalHost(host: string): boolean {
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTNAMES.has(hostname ?? "");
}

/** True when `host` (a Host header value) belongs to this deployment. */
export function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase();
  if (allowedHosts().has(normalized)) return true;
  return !isProduction() && isLocalHost(normalized);
}

/**
 * Browser Origin check for the MCP endpoint. Requests without an Origin
 * (server-to-server MCP clients) are allowed; browser origins must match a
 * known host exactly — substring matching is not used.
 */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return isAllowedHost(url.host);
}

/**
 * Base URL the chat route uses to reach its own MCP endpoint. The Host header
 * is only trusted if it is one of this deployment's own hosts, so a forged
 * Host cannot redirect the server's MCP bearer token elsewhere.
 */
export function internalBaseUrl(host: string | null): string {
  if (host && isAllowedHost(host)) {
    const protocol = isLocalHost(host.toLowerCase()) ? "http" : "https";
    return `${protocol}://${host}`;
  }
  const configured =
    process.env.APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  if (configured) return new URL(configured).origin;
  throw new Error("Cannot determine the application URL. Set APP_URL.");
}
