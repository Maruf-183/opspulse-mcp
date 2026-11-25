"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  FolderPlus,
  LogOut,
  PlugZap,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  ActionPolicyDTO,
  ActionRequestDTO,
  ActivityEventDTO,
  OverviewDTO,
  ProjectDetailDTO,
  ProjectSummaryDTO,
  Tier,
} from "@/gateway/types";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Me = {
  user: { login: string; name: string | null; avatarUrl: string | null } | null;
  mcpUrl: string;
};
type Connection = { grantId: string; app: string; connectedAt: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Something went wrong (${res.status}).`);
  return body?.data as T;
}

const RULES: Array<{ tier: Tier; label: string; hint: string; tone: string }> = [
  { tier: "auto", label: "Run automatically", hint: "Happens right away", tone: "emerald" },
  { tier: "undo", label: "Run, can undo", hint: "You can reverse it for 10 minutes", tone: "sky" },
  { tier: "ask", label: "Ask me first", hint: "Waits for your OK", tone: "amber" },
  { tier: "never", label: "Never allow", hint: "The AI can't do this", tone: "rose" },
];

const TONE: Record<string, string> = {
  emerald: "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200",
  sky: "border-sky-500 bg-sky-50 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200",
  amber: "border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200",
  rose: "border-rose-500 bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200",
};

const timeAgo = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
};

const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 30) || "project";

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Section({ title, hint, children, action }: { title: string; hint: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Button({
  children,
  onClick,
  kind = "secondary",
  disabled,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const style = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 border-blue-600",
    secondary: "bg-white text-slate-800 hover:bg-slate-50 border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-700",
    danger: "bg-white text-rose-700 hover:bg-rose-50 border-rose-300 dark:bg-slate-800 dark:text-rose-300 dark:border-rose-900",
  }[kind];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-wait disabled:opacity-50 ${style}`}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-300 p-5 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{children}</p>;
}

// ---------------------------------------------------------------------------
// Approval card — the most important screen
// ---------------------------------------------------------------------------

function ApprovalCard({ request, onDecide, busy }: { request: ActionRequestDTO; onDecide: (id: string, verb: "approve" | "reject") => void; busy: boolean }) {
  return (
    <article className="rounded-xl border-2 border-amber-400 bg-amber-50/60 p-4 dark:border-amber-500/60 dark:bg-amber-500/5">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-amber-800 dark:text-amber-300">
        <ShieldCheck size={14} aria-hidden /> AI is asking · {request.projectName} · {timeAgo(request.createdAt)}
      </div>
      <h3 className="mt-2 text-base font-semibold text-slate-900 dark:text-white">{request.summary}</h3>

      {request.reasons.length > 0 && (
        <div className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          <span className="font-medium">Why we&apos;re asking: </span>
          {request.reasons.join(" ")}
        </div>
      )}

      {request.preview && request.preview.changes.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white text-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="grid grid-cols-3 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <span>What</span>
            <span>Now</span>
            <span>After</span>
          </div>
          {request.preview.changes.map((c, i) => (
            <div key={i} className="grid grid-cols-3 gap-2 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
              <span className="font-medium text-slate-700 dark:text-slate-200">{c.label}</span>
              <span className="text-slate-500 line-through decoration-slate-300 dark:text-slate-400">{c.before ?? "—"}</span>
              <span className="font-medium text-slate-900 dark:text-white">{c.after ?? "Removed"}</span>
            </div>
          ))}
        </div>
      )}

      {request.preview?.warnings.map((w) => (
        <p key={w} className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 p-2.5 text-sm font-medium text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {w}
        </p>
      ))}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Button kind="secondary" disabled={busy} onClick={() => onDecide(request.id, "reject")}>
          <X size={16} aria-hidden /> Decline
        </Button>
        <Button kind="primary" disabled={busy} onClick={() => onDecide(request.id, "approve")}>
          <Check size={16} aria-hidden /> Allow
        </Button>
      </div>
    </article>
  );
}

function UndoRow({ request, onUndo, busy }: { request: ActionRequestDTO; onUndo: (id: string) => void; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Date.parse(request.undoUntil!) - now);
  if (left === 0) return null;
  const mm = Math.floor(left / 60000);
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="font-medium text-slate-900 dark:text-white">{request.summary}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {request.projectName} · undo possible for {mm}:{ss}
        </p>
      </div>
      <Button kind="secondary" disabled={busy} onClick={() => onUndo(request.id)}>
        <RotateCcw size={16} aria-hidden /> Undo
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Projects and their rules
// ---------------------------------------------------------------------------

function RulePicker({ action, onChange, busy }: { action: ActionPolicyDTO; onChange: (tier: Tier) => void; busy: boolean }) {
  return (
    <div role="radiogroup" aria-label={`Rule for ${action.title}`} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {RULES.map((rule) => {
        const selected = action.tier === rule.tier;
        const unavailable = rule.tier === "undo" && !action.supportsUndo;
        return (
          <button
            key={rule.tier}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={busy || unavailable}
            title={unavailable ? "This project can't undo this action" : rule.hint}
            onClick={() => onChange(rule.tier)}
            className={`min-h-11 rounded-lg border px-2 py-1.5 text-left text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              selected ? TONE[rule.tone] : "border-slate-200 text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300"
            }`}
          >
            {rule.label}
          </button>
        );
      })}
    </div>
  );
}

function ProjectRow({ project, onError }: { project: ProjectSummaryDTO; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ProjectDetailDTO | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api<ProjectDetailDTO>(`/api/projects/${project.id}`));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [project.id, onError]);

  async function setRule(action: string, tier: Tier) {
    setBusy(action);
    try {
      await api(`/api/projects/${project.id}/actions/${action}`, { method: "PATCH", body: JSON.stringify({ tier }) });
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!detail) void load();
        }}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span>
          <span className="block font-semibold text-slate-900 dark:text-white">{project.name}</span>
          <span className="block text-sm text-slate-500 dark:text-slate-400">
            {project.actionCount} things the AI can do{project.pendingCount ? ` · ${project.pendingCount} waiting for you` : ""}
          </span>
        </span>
        <ChevronDown size={18} className={`shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="mt-3 space-y-4 rounded-xl bg-slate-50 p-4 dark:bg-slate-950/40">
          {!detail && <p className="text-sm text-slate-500">Loading…</p>}
          {detail?.actions.map((action) => (
            <div key={action.name}>
              <p className="text-sm font-semibold text-slate-900 dark:text-white">{action.title}</p>
              {action.description && <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">{action.description}</p>}
              <RulePicker action={action} busy={busy === action.name} onChange={(tier) => void setRule(action.name, tier)} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function AddProject({ onAdded, onError }: { onAdded: (secret?: string) => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState<"mcp" | "database" | "manifest">("mcp");
  const [readOnly, setReadOnly] = useState(true);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [manifest, setManifest] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const engine = url.startsWith("mysql://") ? "mysql" : "postgres";
      const body =
        mode === "database"
          ? { manifest: { slug: slugify(name), name, connector: { type: "database", engine, readOnly } }, connectionUrl: url }
          : mode === "mcp"
          ? {
              manifest: { slug: slugify(name), name, connector: { type: "mcp", url } },
              upstreamHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
            }
          : { manifest: JSON.parse(manifest) };
      const res = await api<{ secret?: string }>("/api/projects", { method: "POST", body: JSON.stringify(body) });
      setName("");
      setUrl("");
      setToken("");
      setManifest("");
      onAdded(res.secret);
    } catch (err) {
      onError(err instanceof SyntaxError ? "That project description isn't valid JSON." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20 dark:border-slate-700 dark:bg-slate-950 dark:text-white";
  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex gap-2 text-sm" role="tablist">
        {(["mcp", "database", "manifest"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-3 py-1.5 font-medium ${mode === m ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "text-slate-600 dark:text-slate-300"}`}
          >
            {m === "mcp" ? "Connect a tool (link)" : m === "database" ? "Database" : "Advanced"}
          </button>
        ))}
      </div>
      {mode === "database" ? (
        <>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Name
            <input className={input} required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Company website database" />
          </label>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Database connection link
            <input className={input} required type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="postgres://… or mysql://…" />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read only (recommended to start)
          </label>
          <p className="text-xs text-slate-500">The link is stored encrypted and never shown again. Use a database user with only the access you want the AI to have. Passwords and tokens are never shown to the AI; emails and phone numbers are partly hidden.</p>
        </>
      ) : mode === "mcp" ? (
        <>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Name
            <input className={input} required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Company GitHub" />
          </label>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Connection link (MCP server address)
            <input className={input} required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" />
          </label>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Access key <span className="font-normal text-slate-400">(only if the tool gave you one)</span>
            <input className={input} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <p className="text-xs text-slate-500">OpsPulse finds everything the tool can do and sets safe rules: reading runs automatically, everything else asks you first.</p>
        </>
      ) : (
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
          Project description (opspulse.manifest.json)
          <textarea className={`${input} h-40 font-mono text-xs`} required value={manifest} onChange={(e) => setManifest(e.target.value)} />
        </label>
      )}
      <Button type="submit" kind="primary" disabled={busy}>
        <FolderPlus size={16} aria-hidden /> Add project
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [overview, setOverview] = useState<OverviewDTO | null>(null);
  const [recent, setRecent] = useState<ActionRequestDTO[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const meData = await api<Me>("/api/me");
      setMe(meData);
      const [ov, executed] = await Promise.all([
        api<OverviewDTO>("/api/overview"),
        api<ActionRequestDTO[]>("/api/requests?status=executed&limit=20"),
      ]);
      setOverview(ov);
      setRecent(executed.filter((r) => r.undoUntil));
      if (meData.user) setConnections(await api<Connection[]>("/api/connections"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // Initial load plus a gentle poll so new approval requests appear by themselves.
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 8000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  const act = useCallback(
    async (path: string, key: string, success: string) => {
      setBusy(key);
      setError("");
      try {
        await api(path, { method: path.startsWith("/api/connections") ? "DELETE" : "POST" });
        setNotice(success);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const stats = useMemo(
    () => [
      { label: "Done today", value: overview?.today.done ?? 0, tone: "text-emerald-600" },
      { label: "Waiting for you", value: overview?.today.waiting ?? 0, tone: "text-amber-600" },
      { label: "Blocked", value: overview?.today.blocked ?? 0, tone: "text-rose-600" },
      { label: "Undone", value: overview?.today.undone ?? 0, tone: "text-sky-600" },
    ],
    [overview],
  );

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-blue-600 text-white">
              <Activity size={18} aria-hidden />
            </span>
            <div>
              <p className="font-semibold leading-tight">OpsPulse</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">You decide what AI may do</p>
            </div>
          </div>
          {me?.user ? (
            <div className="flex items-center gap-2">
              {/* GitHub avatar: tiny, external, not worth next/image config. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {me.user.avatarUrl && <img src={me.user.avatarUrl} alt="" className="size-8 rounded-full" />}
              <span className="hidden text-sm font-medium sm:inline">{me.user.name ?? me.user.login}</span>
              <button type="button" onClick={() => void signOut()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Sign out">
                <LogOut size={18} aria-hidden />
              </button>
            </div>
          ) : (
            <a href="/api/auth/github?next=/dashboard" className="inline-flex min-h-10 items-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white dark:bg-white dark:text-slate-900">
              Sign in with GitHub
            </a>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        {(error || notice) && (
          <div
            role="status"
            className={`flex items-start justify-between gap-3 rounded-xl p-3 text-sm ${error ? "bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200" : "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200"}`}
          >
            <span>{error || notice}</span>
            <button type="button" aria-label="Dismiss" onClick={() => (setError(""), setNotice(""))}>
              <X size={16} />
            </button>
          </div>
        )}

        {!me?.user && me && (
          <p className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-500/10 dark:text-blue-200">
            You&apos;re in a demo workspace. Sign in to connect your own AI apps and projects.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className={`text-3xl font-bold ${s.tone}`}>{s.value}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{s.label}</p>
            </div>
          ))}
        </div>

        <Section title="Waiting for your OK" hint="The AI wants to do these. Nothing happens until you allow it.">
          {overview?.pending.length ? (
            <div className="space-y-3">
              {overview.pending.map((r) => (
                <ApprovalCard
                  key={r.id}
                  request={r}
                  busy={busy === r.id}
                  onDecide={(id, verb) => void act(`/api/requests/${id}/${verb}`, id, verb === "approve" ? "Done — it ran." : "Declined.")}
                />
              ))}
            </div>
          ) : (
            <Empty>Nothing is waiting for you.</Empty>
          )}
        </Section>

        {recent.length > 0 && (
          <Section title="Recently done — you can still undo" hint="Changed your mind? Reverse it before the timer runs out.">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recent.map((r) => (
                <UndoRow key={r.id} request={r} busy={busy === r.id} onUndo={(id) => void act(`/api/requests/${id}/undo`, id, "Undone.")} />
              ))}
            </ul>
          </Section>
        )}

        <Section title="Connect your AI" hint="Use OpsPulse from Claude, then just tell Claude what to do.">
          <ol className="space-y-2 text-sm text-slate-700 dark:text-slate-300">
            <li>1. In Claude, open <b>Settings → Connectors → Add custom connector</b>.</li>
            <li className="flex flex-wrap items-center gap-2">
              2. Paste this link:
              <code className="rounded-lg bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{me?.mcpUrl ?? "…"}</code>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium dark:border-slate-700"
                onClick={() => {
                  if (me) void navigator.clipboard.writeText(me.mcpUrl).then(() => setCopied(true));
                }}
              >
                <Copy size={12} aria-hidden /> {copied ? "Copied" : "Copy"}
              </button>
            </li>
            <li>3. Sign in, press <b>Allow</b> — done. Try: “Show me what I can do in my projects.”</li>
          </ol>
          {me?.user && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-semibold">Connected apps</p>
              {connections.length ? (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {connections.map((c) => (
                    <li key={c.grantId} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="flex items-center gap-2 text-sm">
                        <Bot size={16} aria-hidden /> {c.app} <span className="text-slate-400">· connected {timeAgo(c.connectedAt)}</span>
                      </span>
                      <Button kind="danger" disabled={busy === c.grantId} onClick={() => void act(`/api/connections/${c.grantId}`, c.grantId, "Disconnected.")}>
                        Disconnect
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No AI app connected yet.</Empty>
              )}
            </div>
          )}
        </Section>

        <Section
          title="Your projects"
          hint="Open a project to choose what the AI may do in it."
          action={
            <Button kind="secondary" onClick={() => setAdding(!adding)}>
              <PlugZap size={16} aria-hidden /> {adding ? "Close" : "Add project"}
            </Button>
          }
        >
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {overview?.projects.map((p) => <ProjectRow key={p.id} project={p} onError={setError} />)}
          </ul>
          {adding && (
            <AddProject
              onError={setError}
              onAdded={(secret) => {
                setAdding(false);
                setNotice(secret ? `Project added. Its secret key (shown only once): ${secret}` : "Project added.");
                void refresh();
              }}
            />
          )}
        </Section>

        <Section title="What happened" hint="Every AI action and every decision, in order. This log can't be secretly edited.">
          {overview?.recent.length ? (
            <ul className="space-y-3">
              {overview.recent.map((e: ActivityEventDTO) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" aria-hidden />
                  <span>
                    <span className="text-slate-900 dark:text-white">{e.summary}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {e.projectName ? `${e.projectName} · ` : ""}
                      {timeAgo(e.createdAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing has happened yet.</Empty>
          )}
        </Section>

        <p className="pb-6 text-center text-sm text-slate-500">
          <Link className="underline" href="/">
            Try the AI demo
          </Link>
        </p>
      </main>
    </div>
  );
}
