"use client";

import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiteHeader } from "@/components/brand";
import type { ActionRequestDTO, OverviewDTO } from "@/gateway/types";

const STARTERS = [
  "What can you do here?",
  "Add a note: order coffee beans for the office",
  "Rename that note to “Coffee for the team”",
  "Delete that note",
];

const TOOL_LABEL: Record<string, string> = {
  list_projects: "Looked at your projects",
  find_actions: "Checked what it's allowed to do",
  run_action: "Asked OpsPulse to do it",
  request_status: "Checked on a request",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? "Something went wrong. Try again.");
  return body?.data as T;
}

/** Renders [text](url) links and plain text safely, without HTML injection. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        if (link) {
          return (
            <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="font-semibold text-brand underline underline-offset-2">
              {link[1]}
            </a>
          );
        }
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export default function TryPage() {
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<ActionRequestDTO[]>([]);
  const [undoable, setUndoable] = useState<ActionRequestDTO[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [overview, executed] = await Promise.all([
        api<OverviewDTO>("/api/overview"),
        api<ActionRequestDTO[]>("/api/requests?status=executed&limit=10"),
      ]);
      setPending(overview.pending);
      setUndoable(executed.filter((r) => r.undoUntil));
    } catch {
      /* the panel simply stays as it was */
    }
  }, []);

  useEffect(() => {
    // /api/me gives this browser its own private sample workspace.
    void api("/api/me").then(() => {
      setReady(true);
      void refresh();
    });
    const t = setInterval(() => void refresh(), 6000);
    return () => clearInterval(t);
  }, [refresh]);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { messages, sendMessage, status, error } = useChat({ transport, onFinish: () => void refresh() });
  const thinking = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function send(text: string) {
    const value = text.trim();
    if (!value || thinking || !ready) return;
    setInput("");
    void sendMessage({ text: value });
  }

  async function decide(id: string, verb: "approve" | "reject" | "undo") {
    setBusy(id);
    try {
      await api(`/api/requests/${id}/${verb}`, { method: "POST" });
      setNotice(verb === "approve" ? "Allowed — it's done." : verb === "reject" ? "Declined. Nothing changed." : "Undone.");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
      void refresh();
    }
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1.4fr_1fr]">
        <section className="flex min-h-[70vh] flex-col rounded-2xl border border-line bg-card">
          <div className="border-b border-line px-5 py-4">
            <h1 className="font-display text-2xl">Try it with sample notes</h1>
            <p className="text-sm text-muted">Talk to the assistant. Reading and writing notes happens right away; deleting asks you first.</p>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" aria-live="polite">
            {messages.length === 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="rounded-xl border border-line p-3 text-left text-sm hover:border-ink">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                <div className={m.role === "user" ? "max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-paper" : "max-w-[95%] space-y-2"}>
                  {m.parts.map((part, i) => {
                    if (part.type === "text") return <p key={i} className="whitespace-pre-wrap leading-relaxed"><RichText text={part.text} /></p>;
                    if (part.type.startsWith("tool-")) {
                      const name = part.type.slice(5);
                      return (
                        <span key={i} className="mr-2 inline-block rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand">
                          {TOOL_LABEL[name] ?? "Worked on it"}
                        </span>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}
            {thinking && <p className="text-sm text-muted">Thinking…</p>}
            {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error.message}</p>}
            <div ref={bottom} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex gap-2 border-t border-line p-3"
          >
            <label htmlFor="ask" className="sr-only">
              Message
            </label>
            <input
              id="ask"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={1500}
              placeholder="Add a note about Friday's meeting"
              className="min-h-11 flex-1 rounded-xl border border-line bg-paper px-4 focus:border-brand focus:outline-none"
            />
            <button type="submit" disabled={!input.trim() || thinking || !ready} className="rounded-xl bg-brand px-5 font-semibold text-paper disabled:opacity-40">
              Send
            </button>
          </form>
        </section>

        <aside className="space-y-4">
          {notice && (
            <p role="status" className="rounded-xl bg-brand-soft px-4 py-3 text-sm text-brand">
              {notice}
            </p>
          )}
          <section className="rounded-2xl border border-line bg-card p-5">
            <h2 className="font-semibold">Waiting for you</h2>
            {pending.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Nothing right now. Ask the assistant to delete a note to see an approval.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {pending.map((r) => (
                  <li key={r.id} className="rounded-xl border-2 border-amber/60 bg-amber-soft/40 p-4">
                    <p className="font-display text-lg leading-snug">{r.summary}</p>
                    {r.preview?.changes.map((c, i) => (
                      <p key={i} className="mt-1 text-sm text-muted">
                        {c.label}: <span className="line-through">{c.before ?? "—"}</span> → <span className="font-medium text-ink">{c.after ?? "removed"}</span>
                      </p>
                    ))}
                    {r.reasons.length > 0 && <p className="mt-1 text-sm text-amber">{r.reasons.join(" ")}</p>}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" disabled={busy === r.id} onClick={() => void decide(r.id, "reject")} className="rounded-xl border border-line py-2 text-sm font-semibold">
                        Decline
                      </button>
                      <button type="button" disabled={busy === r.id} onClick={() => void decide(r.id, "approve")} className="rounded-xl bg-brand py-2 text-sm font-semibold text-paper">
                        Allow
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-line bg-card p-5">
            <h2 className="font-semibold">You can still undo</h2>
            {undoable.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Changes that can be reversed show up here for 10 minutes.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {undoable.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span>{r.summary}</span>
                    <button type="button" disabled={busy === r.id} onClick={() => void decide(r.id, "undo")} className="rounded-lg border border-line px-3 py-1.5 font-semibold">
                      Undo
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="px-1 text-sm text-muted">
            This sample is private to your browser and resets after a while. To use OpsPulse with your own systems, read the{" "}
            <Link href="/guide" className="text-brand underline">
              guide
            </Link>
            .
          </p>
        </aside>
      </main>
    </>
  );
}
