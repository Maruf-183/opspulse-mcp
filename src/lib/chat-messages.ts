import type { UIMessage } from "ai";

export const MAX_MESSAGES = 30;
export const MAX_PROMPT_CHARS = 1500;
export const MAX_HISTORY_CHARS = 20_000;

export type ParsedMessages =
  | { ok: true; messages: UIMessage[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accepts chat history from the browser, keeping only what the client can
 * legitimately author: `user` and `assistant` roles with plain text parts.
 *
 * Client-supplied `system` messages and tool-call/tool-result parts are
 * dropped — otherwise a caller could inject instructions or forge tool
 * output that the model would treat as trusted.
 */
export function parseChatMessages(body: unknown): ParsedMessages {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return { ok: false, error: "Request body must contain a messages array." };
  }
  if (body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return { ok: false, error: `Message history must contain 1-${MAX_MESSAGES} messages.` };
  }

  const messages: UIMessage[] = [];
  let totalChars = 0;

  for (const candidate of body.messages) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") {
      return { ok: false, error: "Each message needs a string id." };
    }
    if (candidate.role !== "user" && candidate.role !== "assistant") continue;

    const rawParts = Array.isArray(candidate.parts)
      ? candidate.parts
      : typeof candidate.content === "string"
        ? [{ type: "text", text: candidate.content }]
        : [];

    const parts = rawParts
      .filter(
        (part): part is { type: "text"; text: string } =>
          isRecord(part) && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => ({ type: "text" as const, text: part.text }));

    if (parts.length === 0) continue;
    totalChars += parts.reduce((sum, part) => sum + part.text.length, 0);
    messages.push({ id: candidate.id, role: candidate.role, parts });
  }

  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    return { ok: false, error: "The last message must be a user message." };
  }
  const lastText = last.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  if (lastText.length > MAX_PROMPT_CHARS) {
    return { ok: false, error: `Message too long. Maximum ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.` };
  }
  if (totalChars > MAX_HISTORY_CHARS) {
    return { ok: false, error: "Conversation is too long. Start a new conversation." };
  }
  return { ok: true, messages };
}
