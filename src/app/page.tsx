import Link from "next/link";
import { Mark, RULE_STYLE, SiteHeader } from "@/components/brand";

const steps = [
  {
    title: "Connect your systems",
    body: "Your website, database, or the tools you already use. A developer does this once; it usually takes minutes, not code.",
  },
  {
    title: "Add OpsPulse to Claude",
    body: "In Claude, add OpsPulse as a connector, sign in, and press Allow. That's the whole setup for everyone else.",
  },
  {
    title: "Just ask",
    body: "Type or say what you need. Routine work happens right away. Anything important waits for your OK.",
  },
];

const trust = [
  { title: "Only people approve", body: "The AI can ask. It can never say yes to itself or change your rules." },
  { title: "What you approve is what runs", body: "If anything changes after you looked, OpsPulse stops and asks again." },
  { title: "Mistakes can be undone", body: "Many actions come with a ten-minute undo, so you don't have to approve them first." },
  { title: "Everything is on record", body: "Every action and decision is logged, and the log can't be quietly edited." },
];

function ApprovalPreview() {
  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-[0_1px_0_var(--line),0_24px_48px_-24px_rgba(28,29,26,0.25)]">
      <p className="text-xs font-medium tracking-wide text-amber">Waiting for you · Company website</p>
      <p className="mt-2 font-display text-xl leading-snug">Publish the post “What we learned shipping in 2026”</p>
      <dl className="mt-4 divide-y divide-line rounded-xl border border-line text-sm">
        <div className="grid grid-cols-3 gap-2 px-3 py-2">
          <dt className="text-muted">Status</dt>
          <dd className="text-muted line-through">Draft</dd>
          <dd className="font-medium">Published</dd>
        </div>
        <div className="grid grid-cols-3 gap-2 px-3 py-2">
          <dt className="text-muted">Who sees it</dt>
          <dd className="text-muted line-through">Only your team</dd>
          <dd className="font-medium">Everyone</dd>
        </div>
      </dl>
      <p className="mt-3 rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber">1,240 subscribers will get an email about it.</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <span className="rounded-xl border border-line py-2.5 text-center text-sm font-semibold">Decline</span>
        <span className="rounded-xl bg-brand py-2.5 text-center text-sm font-semibold text-paper">Allow</span>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-14 md:grid-cols-[1.15fr_1fr] md:pt-20">
          <div>
            <h1 className="font-display text-5xl leading-[1.05] tracking-tight md:text-6xl">
              Let AI do the work.
              <br />
              <span className="text-brand">You stay in charge.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              OpsPulse sits between AI assistants like Claude and the systems you run. Every action follows the rules you set, and
              nothing important happens without your OK.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/try" className="rounded-xl bg-brand px-5 py-3 font-semibold text-paper hover:opacity-90">
                Try it now
              </Link>
              <Link href="/guide" className="rounded-xl border border-line bg-card px-5 py-3 font-semibold hover:border-ink">
                How to connect Claude
              </Link>
            </div>
            <p className="mt-3 text-sm text-muted">No sign-up needed to try it.</p>
          </div>
          <ApprovalPreview />
        </section>

        <section className="border-y border-line bg-card">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <h2 className="font-display text-3xl tracking-tight">How it works</h2>
            <ol className="mt-8 grid gap-8 md:grid-cols-3">
              {steps.map((step, i) => (
                <li key={step.title}>
                  <span className="font-mono text-sm text-brand">0{i + 1}</span>
                  <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="font-display text-3xl tracking-tight">Four simple rules</h2>
          <p className="mt-3 max-w-2xl text-muted">
            Every action gets one of these. Safe defaults are set for you, and you can change any of them with a click.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.values(RULE_STYLE).map((rule) => (
              <div key={rule.label} className="rounded-2xl border border-line bg-card p-5">
                <span className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${rule.chip}`}>{rule.label}</span>
                <p className="mt-3 text-muted">{rule.short}.</p>
              </div>
            ))}
          </div>
          <p className="mt-5 text-sm text-muted">
            Unusual requests ask first even when the rule says otherwise: very large changes, something the AI has never done
            before, or work outside office hours. You always see why.
          </p>
        </section>

        <section className="border-y border-line bg-card">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-2">
            <div>
              <h2 className="font-display text-3xl tracking-tight">Works with what you already have</h2>
              <p className="mt-3 text-muted">
                Use it from Claude, ChatGPT or Cursor. Connect almost any system without writing code.
              </p>
            </div>
            <ul className="grid gap-3 text-sm sm:grid-cols-2">
              {[
                ["Databases", "Postgres and MySQL, read-only to start"],
                ["Apps with an API", "Anything with an OpenAPI description"],
                ["Tools you use", "GitHub, Notion, Slack and more"],
                ["Your own website", "A few lines in any language"],
              ].map(([title, body]) => (
                <li key={title} className="rounded-xl border border-line p-4">
                  <p className="font-semibold">{title}</p>
                  <p className="mt-1 text-muted">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="font-display text-3xl tracking-tight">Built to be trusted</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {trust.map((item) => (
              <div key={item.title} className="border-l-2 border-brand pl-4">
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-1 text-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-muted">
          <span className="flex items-center gap-2">
            <Mark size={20} /> OpsPulse
          </span>
          <span className="flex gap-4">
            <Link href="/guide" className="hover:text-ink">
              Guide
            </Link>
            <a href="https://github.com/Maruf-183/opspulse-mcp" className="hover:text-ink">
              Source on GitHub
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}
