import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MCP_API_KEY: z.string().min(8, "MCP_API_KEY must be at least 8 characters"),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  /** HMAC key for signed sandbox sessions. Falls back to a key derived from MCP_API_KEY. */
  SESSION_SECRET: z.string().min(32).optional(),
  /** Canonical public origin, e.g. https://opspulse-work.vercel.app */
  APP_URL: z.url().optional(),
  CRON_SECRET: z.string().min(1).optional(),
  /** GitHub OAuth app for "Sign in with GitHub". */
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  /** Google OAuth client for "Continue with Google". */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Validated server environment. Parsed lazily so that importing a module does
 * not fail at build time; the first request that needs it fails loudly instead.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = Object.keys(z.flattenError(parsed.error).fieldErrors).join(", ");
    throw new Error(`Invalid environment variables: ${fields}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () =>
  process.env.VERCEL_ENV === "production" ||
  (process.env.VERCEL_ENV === undefined && process.env.NODE_ENV === "production");
