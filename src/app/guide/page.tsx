import Link from "next/link";
import { RULE_STYLE, SiteHeader } from "@/components/brand";

export const metadata = { title: "Guide — OpsPulse" };

const CONNECT_URL = "https://opspulse-work.vercel.app/api/mcp/mcp";

const sections = [
  ["what", "What OpsPulse does"],
  ["connect", "Connect Claude"],
  ["ask", "Ask for things"],
  ["approve", "Approve and undo"],
  ["rules", "The four rules"],
  ["systems", "Connect your systems"],
  ["help", "If something goes wrong"],
] as const;

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 font-display text-3xl tracking-tight">
      {children}
    </h2>
  );
}

export default function GuidePage() {
  return (
    <>
      <SiteHeader />
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-10 md:grid-cols-[200px_1fr]">
        <nav aria-label="On this page" className="md:sticky md:top-6 md:self-start">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">On this page</p>
          <ul className="mt-3 space-y-2 text-sm">
            {sections.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-muted hover:text-ink">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="max-w-2xl space-y-14 leading-relaxed">
          <header>
            <h1 className="font-display text-5xl tracking-tight">Guide</h1>
            <p className="mt-4 text-lg text-muted">Everything you need to use OpsPulse. No technical knowledge needed.</p>
          </header>

          <section className="space-y-4">
            <H2 id="what">What OpsPulse does</H2>
            <p>
              When you ask an AI assistant like Claude to do something in one of your systems, OpsPulse checks your rules first.
              Routine work happens straight away. Anything important waits until you say yes.
            </p>
            <p className="text-muted">
              Think of a new colleague: they handle small things on their own, check with you before anything big, and some things
              they never do. You are the manager.
            </p>
          </section>

          <section className="space-y-4">
            <H2 id="connect">Connect Claude</H2>
            <p>You only do this once. It takes about two minutes.</p>
            <ol className="list-decimal space-y-3 pl-5">
              <li>
                Open <strong>claude.ai</strong> and sign in.
              </li>
              <li>
                Click your name in the bottom-left corner, then <strong>Settings</strong>, then <strong>Connectors</strong>.
              </li>
              <li>
                Click <strong>Add custom connector</strong>. Name it <strong>OpsPulse</strong> and paste this address:
                <code className="mt-2 block break-all rounded-lg border border-line bg-card px-3 py-2 font-mono text-sm">{CONNECT_URL}</code>
              </li>
              <li>
                Click <strong>Add</strong>, then <strong>Connect</strong>.
              </li>
              <li>
                Sign in with <strong>Google</strong> or <strong>GitHub</strong>, and press <strong>Allow</strong>.
              </li>
            </ol>
            <p className="text-muted">
              You&apos;ll see OpsPulse marked as connected. It works in the Claude app on your phone too. If you don&apos;t see
              “Add custom connector”, your Claude plan may not include it yet; ask the person who set up OpsPulse for you.
            </p>
          </section>

          <section className="space-y-4">
            <H2 id="ask">Ask for things</H2>
            <p>Talk to Claude the way you would talk to a colleague. You can type or use the microphone. Start with:</p>
            <blockquote className="rounded-xl border-l-4 border-brand bg-card px-4 py-3 font-display text-lg">
              What can you do in my projects?
            </blockquote>
            <p>Then ask for real work, using your project&apos;s name however you normally say it:</p>
            <ul className="space-y-2">
              {[
                "Show me the new enquiries from the website this week.",
                "Write a draft blog post about our new opening hours.",
                "Mark the enquiry from Rahim as won.",
                "Publish the draft we wrote yesterday.",
              ].map((example) => (
                <li key={example} className="rounded-xl border border-line bg-card px-4 py-2.5">
                  “{example}”
                </li>
              ))}
            </ul>
            <p className="text-muted">
              Want to practise first? <Link href="/try" className="text-brand underline">Try it with sample notes</Link>, no sign-up needed.
            </p>
          </section>

          <section className="space-y-4">
            <H2 id="approve">Approve and undo</H2>
            <p>
              When something needs your OK, Claude says so and gives you a link. Open it, read what will change, and press{" "}
              <strong>Allow</strong> or <strong>Decline</strong>. Nothing happens until you decide, and requests nobody answers
              expire after a day.
            </p>
            <p>
              Some changes happen right away but can be reversed for ten minutes. Claude gives you an <strong>Undo</strong> link
              for those. You can also see everything waiting for you, and undo recent changes, on the{" "}
              <Link href="/dashboard" className="text-brand underline">dashboard</Link>.
            </p>
            <p className="text-muted">
              The links only work for you: you&apos;ll be asked to sign in, and the AI can&apos;t open them on your behalf.
            </p>
          </section>

          <section className="space-y-4">
            <H2 id="rules">The four rules</H2>
            <p>Every action in a project has one rule. Sensible ones are set for you when a project is connected.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.values(RULE_STYLE).map((rule) => (
                <div key={rule.label} className="rounded-xl border border-line bg-card p-4">
                  <span className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${rule.chip}`}>{rule.label}</span>
                  <p className="mt-2 text-muted">{rule.short}.</p>
                </div>
              ))}
            </div>
            <p>
              To change a rule, open the <Link href="/dashboard" className="text-brand underline">dashboard</Link>, click a
              project, and pick a different rule next to the action. Only people can change rules; the AI can&apos;t.
            </p>
            <p className="text-muted">
              Even when a rule says “run automatically”, OpsPulse asks first if a request is unusual, for example a very large
              change or something the AI has never done before. It always tells you why.
            </p>
          </section>

          <section className="space-y-4">
            <H2 id="systems">Connect your systems</H2>
            <p>
              Usually a developer does this once. On the <Link href="/dashboard" className="text-brand underline">dashboard</Link>,
              click <strong>Add project</strong> and choose how to connect:
            </p>
            <ul className="space-y-2">
              <li>
                <strong>Database</strong>: paste the connection address. Starts read-only; passwords and private fields are never
                shown to the AI.
              </li>
              <li>
                <strong>API</strong>: paste the address of the API and its OpenAPI description.
              </li>
              <li>
                <strong>Tool link</strong>: for tools that offer an MCP server, such as GitHub or Notion.
              </li>
            </ul>
            <p className="text-muted">
              Developers connecting a custom website can find short examples for Node, Python and PHP in the{" "}
              <a href="https://github.com/Maruf-183/opspulse-mcp#connect-any-system" className="text-brand underline">
                project&apos;s README
              </a>
              .
            </p>
          </section>

          <section className="space-y-4">
            <H2 id="help">If something goes wrong</H2>
            <dl className="divide-y divide-line rounded-xl border border-line bg-card">
              {[
                ["Claude says there are no projects", "Your system isn't connected yet. You can still try the sample notes."],
                ["Claude says it isn't allowed", "That action's rule is “Never allow”. Change it on the dashboard if you want it."],
                ["The approval link says it can't find the request", "Sign in with the same account you used to connect Claude."],
                ["“Things changed since you looked”", "OpsPulse stopped to protect you. Ask Claude again and review the new version."],
                ["Undo isn't there any more", "The ten minutes have passed. Ask Claude to change it back instead."],
              ].map(([q, a]) => (
                <div key={q} className="px-4 py-3">
                  <dt className="font-semibold">{q}</dt>
                  <dd className="text-muted">{a}</dd>
                </div>
              ))}
            </dl>
            <p className="text-muted">Still stuck? Send a screenshot of the page to the person who set up OpsPulse for you.</p>
          </section>
        </article>
      </div>
    </>
  );
}
