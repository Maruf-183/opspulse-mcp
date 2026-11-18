import { NextRequest } from "next/server";
import { google } from "@ai-sdk/google";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { parseChatMessages } from "@/lib/chat-messages";
import { getEnv } from "@/lib/env";
import { errorResponse, getSandboxFromCookie, readJson } from "@/lib/http";
import { OPSPULSE_SYSTEM_PROMPT } from "@/lib/prompts";
import { internalBaseUrl, isAllowedOrigin } from "@/lib/security/origins";
import { SESSION_HEADER, signSandboxId } from "@/lib/security/session";
import { checkRateLimitAndCircuitBreaker, clientIp } from "@/services/ratelimit.service";

export const maxDuration = 60;

function publicAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("429") || message.toLowerCase().includes("quota")) {
    return "The AI provider quota is exhausted. Please try again later.";
  }
  console.error("AI stream error:", error);
  return "The AI assistant could not complete this request.";
}

export async function POST(req: NextRequest) {
  if (!isAllowedOrigin(req.headers.get("origin"))) {
    return errorResponse("FORBIDDEN", "Cross-origin request rejected.");
  }

  const parsed = parseChatMessages(await readJson(req));
  if (!parsed.ok) return errorResponse("VALIDATION_FAILED", parsed.error);

  const sandboxId = getSandboxFromCookie(req);
  if (!sandboxId) {
    return errorResponse("UNAUTHENTICATED", "No valid workspace session. Reload the dashboard.");
  }

  const limit = await checkRateLimitAndCircuitBreaker(clientIp(req.headers));
  if (!limit.allowed) return errorResponse(limit.reason, limit.message);

  let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  try {
    const env = getEnv();
    const mcpUrl = new URL("/api/mcp/mcp", internalBaseUrl(req.headers.get("host"))).toString();

    // The assistant reaches its tools through the real MCP endpoint. It
    // forwards the *signed* session so the MCP server can bind the agent to
    // this user's sandbox; a raw sandbox ID would be forgeable.
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${env.MCP_API_KEY}`,
          [SESSION_HEADER]: signSandboxId(sandboxId),
        },
      },
    });

    const tools = await mcpClient.tools();
    const result = streamText({
      model: google(env.GEMINI_MODEL),
      system: OPSPULSE_SYSTEM_PROMPT,
      messages: await convertToModelMessages(parsed.messages),
      tools,
      stopWhen: stepCountIs(5),
      onFinish: async () => {
        await mcpClient?.close();
      },
      onError: async () => {
        await mcpClient?.close();
      },
    });

    return result.toUIMessageStreamResponse({ onError: publicAiError });
  } catch (error) {
    await mcpClient?.close();
    const message = publicAiError(error);
    return errorResponse(message.includes("quota") ? "RATE_LIMITED" : "INTERNAL", message);
  }
}
