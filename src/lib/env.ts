import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MCP_API_KEY: z.string().min(8, "MCP_API_KEY must be at least 8 characters"),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
