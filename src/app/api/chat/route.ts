import { NextRequest, NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  type UIMessage,
} from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { OPSPULSE_SYSTEM_PROMPT } from "@/lib/prompts";
import { checkRateLimitAndCircuitBreaker } from "@/services/ratelimit.service";

export const maxDuration = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessages(body: unknown): UIMessage[] | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return null;
  }

  const messages: UIMessage[] = [];
  for (const candidate of body.messages) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      (candidate.role !== "user" &&
        candidate.role !== "assistant" &&
        candidate.role !== "system")
    ) {
      return null;
    }

    const parts = Array.isArray(candidate.parts)
      ? candidate.parts
      : typeof candidate.content === "string"
        ? [{ type: "text", text: candidate.content }]
        : null;

    if (!parts) {
      return null;
    }

    messages.push({ ...candidate, parts } as UIMessage);
  }

  return messages;
}

export async function POST(req: NextRequest) {
  let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  try {
    const body: unknown = await req.json();
    const messages = parseMessages(body);

    if (!messages || messages.length === 0 || messages.length > 30) {
      return NextResponse.json(
        { error: "Invalid message history length (must be between 1 and 30)." },
        { status: 400 }
      );
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) {
      return NextResponse.json(
        { error: "Invalid message history length (must be between 1 and 30)." },
        { status: 400 }
      );
    }

    const lastText = lastMsg.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    if (lastText.length > 1500) {
      return NextResponse.json(
        { error: "Message too long. Maximum 1,500 characters allowed per prompt." },
        { status: 400 }
      );
    }

    // ২. Rate Limit ও Global Circuit Breaker চেক
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
    const limitCheck = await checkRateLimitAndCircuitBreaker(ip);

    if (!limitCheck.allowed) {
      return NextResponse.json(
        { error: limitCheck.message, code: limitCheck.reason },
        { status: 429 }
      );
    }

    // ৩. কুকি থেকে স্যান্ডবক্স আইডি নেওয়া
    const sandboxId =
      req.cookies.get("opspulse_sandbox")?.value || "demo-sandbox";

    // ৪. ডায়নামিক বেস URL (Localhost এবং Vercel Production উভয়ের জন্য)
    const protocol = req.headers.get("x-forwarded-proto") || "http";
    const host = req.headers.get("host") || "localhost:3000";
    const mcpUrl = new URL("/api/mcp/mcp", `${protocol}://${host}`).toString();

    // ৫. সত্যিকারের HTTP MCP Client কানেকশন (Bearer Auth + Sandbox Header সহ)
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${process.env.MCP_API_KEY || ""}`,
          "x-sandbox-id": sandboxId,
        },
      },
    });

    const tools = await mcpClient.tools();
    const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    // ৬. Gemini দিয়ে স্ট্রিমিং রেসপন্স
    const result = streamText({
      model: google(modelName),
      system: OPSPULSE_SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      tools,
      stopWhen: stepCountIs(5),
      onFinish: async () => {
        await mcpClient?.close();
      },
      onError: async () => {
        await mcpClient?.close();
      },
    });

    return result.toUIMessageStreamResponse({
      onError: (error) =>
        error instanceof Error ? error.message : String(error),
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to process AI request.";
    await mcpClient?.close();
    const status =
      message.includes("429") || message.toLowerCase().includes("quota")
        ? 429
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
