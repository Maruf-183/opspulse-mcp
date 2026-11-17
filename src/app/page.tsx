"use client";

import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bot,
  Check,
  ClipboardList,
  CircleHelp,
  Clock3,
  Database,
  FileText,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Ticket = {
  id: number;
  title: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | string;
};

type PendingApproval = {
  id: number;
  ticketId: number;
  reason: string;
};

type AuditLog = {
  id: number;
  action: string;
  isError: number;
  latencyMs: number;
  inputPayload: string;
  outputPayload: string;
};

type WorkspaceState = {
  sandboxId: string;
  tickets: Ticket[];
  pendingApprovals: PendingApproval[];
  auditLogs: AuditLog[];
};

const EMPTY_WORKSPACE: WorkspaceState = {
  sandboxId: "",
  tickets: [],
  pendingApprovals: [],
  auditLogs: [],
};

const QUICK_PROMPTS = [
  {
    title: "Create a HIGH priority ticket",
    prompt:
      "Create a HIGH priority ticket for an elevated API error rate. Include a concise title and a clear description.",
    icon: Sparkles,
  },
  {
    title: "List open tickets",
    prompt: "List all OPEN tickets in my workspace.",
    icon: Terminal,
  },
  {
    title: "Executive incident summary",
    prompt:
      "Run the incident_summary_prompt for this workspace and give me its executive incident summary.",
    icon: FileText,
  },
];

const priorityClasses: Record<string, string> = {
  HIGH: "border-rose-400/20 bg-rose-400/10 text-rose-300",
  MEDIUM: "border-amber-400/20 bg-amber-400/10 text-amber-300",
  LOW: "border-sky-400/20 bg-sky-400/10 text-sky-300",
};

const statusClasses: Record<string, string> = {
  OPEN: "bg-emerald-400",
  IN_PROGRESS: "bg-amber-400",
  RESOLVED: "bg-slate-500",
};

function formatPayload(payload: string) {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

function LoadingRows({ count = 3 }: { count?: number }) {
  return (
    <div aria-label="Loading workspace data" aria-live="polite" className="space-y-3">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-xl border border-slate-800 bg-slate-900/70 p-4"
        >
          <div className="mb-3 h-3 w-1/3 rounded bg-slate-800" />
          <div className="mb-2 h-3 w-full rounded bg-slate-800/80" />
          <div className="h-3 w-2/3 rounded bg-slate-800/80" />
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(EMPTY_WORKSPACE);
  const [isLoadingState, setIsLoadingState] = useState(true);
  const [workspaceError, setWorkspaceError] = useState("");
  const [actionError, setActionError] = useState("");
  const [approvalBusyId, setApprovalBusyId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"tickets" | "audit">("tickets");
  const [input, setInput] = useState("");
  const refreshedToolCalls = useRef(new Set<string>());

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const fetchWorkspaceState = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Workspace refresh failed (${response.status}).`);
    }

    const nextState = (await response.json()) as WorkspaceState;
    if (
      typeof nextState.sandboxId !== "string" ||
      !Array.isArray(nextState.tickets) ||
      !Array.isArray(nextState.pendingApprovals) ||
      !Array.isArray(nextState.auditLogs)
    ) {
      throw new Error("The workspace response was invalid.");
    }
    return nextState;
  }, []);

  const refreshState = useCallback(async () => {
    setIsLoadingState(true);
    setWorkspaceError("");
    try {
      setWorkspace(await fetchWorkspaceState());
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : "Could not load workspace state.",
      );
    } finally {
      setIsLoadingState(false);
    }
  }, [fetchWorkspaceState]);

  const handleChatFinish = useCallback(() => {
    void refreshState();
  }, [refreshState]);

  const {
    messages,
    sendMessage,
    status,
    error: chatError,
  } = useChat({
    transport,
    onFinish: handleChatFinish,
  });

  useEffect(() => {
    let hasCompletedToolCall = false;
    for (const message of messages) {
      for (const part of message.parts) {
        if (!part.type.startsWith("tool-")) continue;

        const toolPart = part as {
          toolCallId?: string;
          state?: string;
          preliminary?: boolean;
        };
        const completed =
          toolPart.state === "output-error" ||
          (toolPart.state === "output-available" && !toolPart.preliminary);

        if (
          completed &&
          toolPart.toolCallId &&
          !refreshedToolCalls.current.has(toolPart.toolCallId)
        ) {
          refreshedToolCalls.current.add(toolPart.toolCallId);
          hasCompletedToolCall = true;
        }
      }
    }

    if (hasCompletedToolCall) {
      fetchWorkspaceState()
        .then((nextState) => {
          setWorkspace(nextState);
          setWorkspaceError("");
        })
        .catch((error: unknown) => {
          setWorkspaceError(
            error instanceof Error
              ? error.message
              : "Could not load workspace state.",
          );
        });
    }
  }, [fetchWorkspaceState, messages]);

  useEffect(() => {
    let cancelled = false;
    fetchWorkspaceState()
      .then((nextState) => {
        if (!cancelled) setWorkspace(nextState);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWorkspaceError(
            error instanceof Error
              ? error.message
              : "Could not load workspace state.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingState(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchWorkspaceState]);

  const isChatBusy = status === "submitted" || status === "streaming";

  async function sendPrompt(prompt: string) {
    setActionError("");
    try {
      await sendMessage({ text: prompt });
      return true;
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not send your message.",
      );
      return false;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isChatBusy) return;
    if (await sendPrompt(text)) setInput("");
  }

  async function handleApproval(approvalId: number, approve: boolean) {
    setApprovalBusyId(approvalId);
    setActionError("");
    try {
      const response = await fetch(`/api/approvals/${approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approve }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(result?.error ?? `Approval update failed (${response.status}).`);
      }
      await refreshState();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not update the approval.",
      );
    } finally {
      setApprovalBusyId(null);
    }
  }

  function requestTicketDeletion(ticket: Ticket) {
    void sendPrompt(
      `Request deletion of ticket #${ticket.id} (${ticket.title}). Explain that it needs a human approval and do not delete it directly.`,
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/90 bg-slate-950/95 px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
              <Activity aria-hidden="true" size={22} />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">
                OpsPulse MCP
              </h1>
              <p className="text-xs text-slate-400 sm:text-sm">
                Stateless Streamable HTTP • Server-Enforced HITL • Live Audit
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <div
              aria-label={`Current sandbox: ${workspace.sandboxId || "connecting"}`}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-300"
            >
              <Database aria-hidden="true" className="shrink-0 text-cyan-400" size={14} />
              <span className="text-slate-500">SANDBOX</span>
              <span className="max-w-45 truncate text-slate-200">
                {workspace.sandboxId || (isLoadingState ? "connecting…" : "unavailable")}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void refreshState()}
              disabled={isLoadingState}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Refresh workspace state"
            >
              <RefreshCw
                aria-hidden="true"
                className={isLoadingState ? "animate-spin" : ""}
                size={15}
              />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-[calc(100vh-81px)] max-w-[1600px] grid-cols-1 gap-4 p-4 sm:p-6 lg:grid-cols-2 lg:gap-5 lg:px-8">
        <section
          aria-labelledby="assistant-heading"
          className="flex min-h-155 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40 shadow-2xl shadow-black/10 lg:min-h-[calc(100vh-129px)]"
        >
          <div className="border-b border-slate-800 px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300">
                  <Bot aria-hidden="true" size={19} />
                </div>
                <div>
                  <h2 id="assistant-heading" className="font-semibold text-white">
                    AI Operations Assistant
                  </h2>
                  <p className="text-xs text-slate-500">
                    Workspace-scoped MCP tools
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void sendPrompt(
                      "Read the MCP resource system://schema and explain the OpsPulse workspace schema and its operational rules.",
                    )
                  }
                  disabled={isChatBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-200 disabled:opacity-50"
                  aria-label="Ask the assistant to read the system schema resource"
                >
                  <Database aria-hidden="true" size={14} />
                  system://schema
                  <ArrowUpRight aria-hidden="true" size={12} />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void sendPrompt(
                      "Run the incident_summary_prompt for the current workspace and summarize the active incidents with action items.",
                    )
                  }
                  disabled={isChatBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-violet-400/40 hover:text-violet-200 disabled:opacity-50"
                  aria-label="Run the incident summary prompt"
                >
                  <FileText aria-hidden="true" size={14} />
                  Incident prompt
                  <ArrowUpRight aria-hidden="true" size={12} />
                </button>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
            {workspace.pendingApprovals.length > 0 && (
              <div
                role="region"
                aria-label="Pending human approval requests"
                className="mb-5 space-y-3"
              >
                {workspace.pendingApprovals.map((approval) => (
                  <article
                    key={approval.id}
                    className="rounded-xl border border-amber-400/30 bg-amber-400/[0.07] p-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-400/10 text-amber-300">
                        <ShieldCheck aria-hidden="true" size={17} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-amber-100">
                            Human approval required
                          </h3>
                          <span className="rounded-md border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-200">
                            Ticket #{approval.ticketId}
                          </span>
                        </div>
                        <p className="mt-1.5 text-sm leading-5 text-amber-100/70">
                          {approval.reason}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleApproval(approval.id, true)}
                            disabled={approvalBusyId !== null}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-50"
                          >
                            <Check aria-hidden="true" size={14} />
                            {approvalBusyId === approval.id
                              ? "Updating…"
                              : "Approve Delete"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleApproval(approval.id, false)}
                            disabled={approvalBusyId !== null}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-rose-400/40 hover:text-rose-200 disabled:cursor-wait disabled:opacity-50"
                          >
                            <X aria-hidden="true" size={14} />
                            Reject
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {messages.length === 0 ? (
              <div className="flex min-h-87.5 flex-col justify-center">
                <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-violet-400/20 bg-violet-400/10 text-violet-300">
                  <Sparkles aria-hidden="true" size={22} />
                </div>
                <h3 className="text-xl font-semibold tracking-tight text-white">
                  What can I help you operate?
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
                  Ask about incidents, create an operational ticket, or request a
                  deletion. Destructive actions always wait for your approval.
                </p>
                <h4 className="mt-6 mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Try this
                </h4>
                <div className="grid gap-2 sm:grid-cols-3">
                  {QUICK_PROMPTS.map(({ title, prompt, icon: Icon }) => (
                    <button
                      key={title}
                      type="button"
                      onClick={() => void sendPrompt(prompt)}
                      disabled={isChatBusy}
                      className="group flex min-h-24 flex-col items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-left transition hover:border-slate-600 hover:bg-slate-800/80 disabled:opacity-50"
                    >
                      <Icon
                        aria-hidden="true"
                        className="text-slate-500 transition group-hover:text-cyan-300"
                        size={17}
                      />
                      <span className="text-xs font-medium leading-5 text-slate-300 group-hover:text-white">
                        {title}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-5" aria-live="polite">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={`flex gap-3 ${
                      message.role === "user" ? "flex-row-reverse" : ""
                    }`}
                  >
                    <div
                      className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                        message.role === "user"
                          ? "bg-cyan-400/10 text-cyan-300"
                          : "bg-violet-400/10 text-violet-300"
                      }`}
                    >
                      {message.role === "user" ? (
                        <UserRound aria-hidden="true" size={16} />
                      ) : (
                        <Bot aria-hidden="true" size={16} />
                      )}
                    </div>
                    <div
                      className={`min-w-0 max-w-[88%] space-y-2 ${
                        message.role === "user" ? "text-right" : ""
                      }`}
                    >
                      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                        {message.role === "user" ? "You" : "OpsPulse AI"}
                      </div>
                      <div
                        className={`space-y-2 rounded-xl border px-3.5 py-3 text-left text-sm leading-6 ${
                          message.role === "user"
                            ? "border-cyan-400/15 bg-cyan-400/[0.07] text-slate-200"
                            : "border-slate-800 bg-slate-900 text-slate-300"
                        }`}
                      >
                        {message.parts.map((part, index) => {
                          if (part.type === "text") {
                            return (
                              <p
                                key={`${message.id}-text-${index}`}
                                className="whitespace-pre-wrap wrap-break-word"
                              >
                                {part.text}
                              </p>
                            );
                          }
                          if (part.type.startsWith("tool-")) {
                            const toolName = part.type.slice("tool-".length);
                            return (
                              <span
                                key={`${message.id}-tool-${index}`}
                                className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/20 bg-violet-400/8 px-2 py-1 font-mono text-[11px] text-violet-200"
                              >
                                <Terminal aria-hidden="true" size={12} />
                                {toolName}
                              </span>
                            );
                          }
                          return null;
                        })}
                      </div>
                    </div>
                  </article>
                ))}
                {isChatBusy && (
                  <div className="flex items-center gap-2 pl-11 text-xs text-slate-500" role="status">
                    <span className="size-1.5 animate-pulse rounded-full bg-cyan-400" />
                    Assistant is working…
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-slate-800 bg-slate-950/50 p-4 sm:px-5">
            {(actionError || chatError) && (
              <div
                role="alert"
                className="mb-3 flex items-start gap-2 rounded-lg border border-rose-400/20 bg-rose-400/6 px-3 py-2 text-xs text-rose-200"
              >
                <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
                <span>{actionError || chatError?.message}</span>
              </div>
            )}
            <form onSubmit={handleSubmit} className="relative">
              <label htmlFor="assistant-message" className="sr-only">
                Message the AI Operations Assistant
              </label>
              <textarea
                id="assistant-message"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                maxLength={1500}
                rows={2}
                placeholder="Ask about incidents or manage your workspace…"
                className="w-full resize-none rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 pr-14 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/10 disabled:opacity-60"
                disabled={isChatBusy}
                aria-describedby="message-guidance message-count"
              />
              <button
                type="submit"
                disabled={!input.trim() || isChatBusy}
                className="absolute bottom-2.5 right-2.5 flex size-9 items-center justify-center rounded-lg bg-cyan-400 text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
                aria-label="Send message"
              >
                {isChatBusy ? (
                  <RefreshCw aria-hidden="true" className="animate-spin" size={16} />
                ) : (
                  <Send aria-hidden="true" size={16} />
                )}
              </button>
            </form>
            <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <p id="message-guidance" className="flex items-start gap-1.5 text-[11px] leading-4 text-slate-500">
                <CircleHelp aria-hidden="true" className="mt-0.5 shrink-0" size={12} />
                Free tier demo — do not enter sensitive or personal data. Workspace
                resets automatically after 24h.
              </p>
              <span id="message-count" className="shrink-0 text-right font-mono text-[10px] text-slate-600">
                {input.length}/1500
              </span>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="workspace-heading"
          className="flex min-h-145 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40 shadow-2xl shadow-black/10 lg:min-h-[calc(100vh-129px)]"
        >
          <div className="border-b border-slate-800 px-4 pt-4 sm:px-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 id="workspace-heading" className="font-semibold text-white">
                  Live Workspace
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Tickets, approvals, and MCP activity
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/15 bg-emerald-400/6 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                Live
              </span>
            </div>
            <div className="flex gap-5" role="tablist" aria-label="Workspace views">
              <button
                id="tickets-tab"
                type="button"
                role="tab"
                aria-selected={activeTab === "tickets"}
                aria-controls="tickets-panel"
                onClick={() => setActiveTab("tickets")}
                className={`relative flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition ${
                  activeTab === "tickets"
                    ? "border-cyan-400 text-cyan-200"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                <ClipboardList aria-hidden="true" size={15} />
                Live Tickets
                <span className="rounded-md bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  {workspace.tickets.length}
                </span>
              </button>
              <button
                id="audit-tab"
                type="button"
                role="tab"
                aria-selected={activeTab === "audit"}
                aria-controls="audit-panel"
                onClick={() => setActiveTab("audit")}
                className={`relative flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition ${
                  activeTab === "audit"
                    ? "border-cyan-400 text-cyan-200"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                <FileText aria-hidden="true" size={15} />
                MCP Audit Logs
                <span className="rounded-md bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  {workspace.auditLogs.length}
                </span>
              </button>
            </div>
          </div>

          {workspaceError && (
            <div
              role="alert"
              className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-rose-400/20 bg-rose-400/6 px-3 py-2 text-xs text-rose-200 sm:mx-5"
            >
              <AlertCircle aria-hidden="true" size={14} />
              <span className="flex-1">{workspaceError}</span>
              <button
                type="button"
                onClick={() => void refreshState()}
                className="font-semibold underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            <div
              id="tickets-panel"
              role="tabpanel"
              aria-labelledby="tickets-tab"
              hidden={activeTab !== "tickets"}
            >
              {isLoadingState && workspace.tickets.length === 0 ? (
                <LoadingRows />
              ) : workspace.tickets.length === 0 ? (
                <div className="flex min-h-75 flex-col items-center justify-center px-6 text-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-slate-500">
                    <Database aria-hidden="true" size={21} />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-slate-200">
                    No tickets in this workspace
                  </h3>
                  <p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">
                    Ask the assistant to create a ticket. New workspace activity
                    appears here automatically.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {workspace.tickets.map((ticket) => (
                    <article
                      key={ticket.id}
                      className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 transition hover:border-slate-700"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[10px] text-slate-500">
                              TKT-{ticket.id}
                            </span>
                            <span
                              className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                priorityClasses[ticket.priority] ??
                                "border-slate-700 bg-slate-800 text-slate-300"
                              }`}
                            >
                              {ticket.priority}
                            </span>
                            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                              <span
                                className={`size-1.5 rounded-full ${
                                  statusClasses[ticket.status] ?? "bg-slate-500"
                                }`}
                              />
                              {ticket.status.replace(/_/g, " ")}
                            </span>
                          </div>
                          <h3 className="wrap-break-word text-sm font-semibold text-slate-100">
                            {ticket.title}
                          </h3>
                          <p className="mt-1.5 whitespace-pre-wrap wrap-break-word text-xs leading-5 text-slate-400">
                            {ticket.description}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => requestTicketDeletion(ticket)}
                          disabled={isChatBusy}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-400/20 bg-rose-400/5 px-2.5 py-2 text-[11px] font-medium text-rose-300 transition hover:border-rose-400/40 hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Request AI deletion of ticket ${ticket.id}`}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                          Request AI Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div
              id="audit-panel"
              role="tabpanel"
              aria-labelledby="audit-tab"
              hidden={activeTab !== "audit"}
            >
              {isLoadingState && workspace.auditLogs.length === 0 ? (
                <LoadingRows count={4} />
              ) : workspace.auditLogs.length === 0 ? (
                <div className="flex min-h-75 flex-col items-center justify-center px-6 text-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-slate-500">
                    <Activity aria-hidden="true" size={21} />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-slate-200">
                    No MCP activity yet
                  </h3>
                  <p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">
                    Tool calls and their results will be recorded here.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {workspace.auditLogs.map((log) => (
                    <article
                      key={log.id}
                      className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`size-2 shrink-0 rounded-full ${
                              log.isError ? "bg-rose-400" : "bg-emerald-400"
                            }`}
                            aria-hidden="true"
                          />
                          <h3 className="truncate font-mono text-xs font-medium text-slate-200">
                            {log.action}
                          </h3>
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                              log.isError
                                ? "bg-rose-400/10 text-rose-300"
                                : "bg-emerald-400/10 text-emerald-300"
                            }`}
                          >
                            {log.isError ? "Error" : "Success"}
                          </span>
                        </div>
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-500">
                          <Clock3 aria-hidden="true" size={12} />
                          {log.latencyMs} ms
                        </span>
                      </div>
                      <div className="grid gap-3 p-4 sm:grid-cols-2">
                        <div className="min-w-0">
                          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                            Input payload
                          </h4>
                          <pre className="max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950/70 p-2.5 font-mono text-[10px] leading-4 text-slate-400">
                            {formatPayload(log.inputPayload)}
                          </pre>
                        </div>
                        <div className="min-w-0">
                          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                            Output payload
                          </h4>
                          <pre className="max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950/70 p-2.5 font-mono text-[10px] leading-4 text-slate-400">
                            {formatPayload(log.outputPayload)}
                          </pre>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3 text-[10px] text-slate-600 sm:px-5">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck aria-hidden="true" size={12} />
              Isolated 24h sandbox
            </span>
            <span>Latest 25 audit events</span>
          </div>
        </section>
      </div>
    </main>
  );
}
