import Link from "next/link";

/** The OpsPulse mark: a gate — two posts and an arch, with a pulse passing through. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 24V14a7 7 0 0 1 14 0v10" fill="none" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M6 19h6l2-3 3 6 2-3h7" fill="none" stroke="var(--paper)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 font-display text-xl font-semibold tracking-tight text-ink">
      <Mark /> OpsPulse
    </Link>
  );
}

export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <Logo />
        <nav className="flex items-center gap-1 text-sm font-medium text-muted sm:gap-3">
          <Link href="/try" className="rounded-lg px-2 py-1.5 hover:text-ink">
            Try it
          </Link>
          <Link href="/guide" className="rounded-lg px-2 py-1.5 hover:text-ink">
            Guide
          </Link>
          {children ?? (
            <Link href="/dashboard" className="rounded-lg bg-ink px-3.5 py-2 text-paper hover:opacity-90">
              Open dashboard
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

/** The four rules, as everywhere in the product. */
export const RULE_STYLE = {
  auto: { label: "Run automatically", short: "Runs right away", chip: "bg-brand-soft text-brand" },
  undo: { label: "Run, can undo", short: "You can reverse it for 10 minutes", chip: "bg-sky-soft text-sky" },
  ask: { label: "Ask me first", short: "Waits for your OK", chip: "bg-amber-soft text-amber" },
  never: { label: "Never allow", short: "The AI can't do it", chip: "bg-danger-soft text-danger" },
} as const;
