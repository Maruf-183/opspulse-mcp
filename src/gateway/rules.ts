/**
 * Pure decision logic: which tier applies to one invocation, and why.
 * No I/O — everything the rules need is passed in, so every branch is unit-tested.
 */
import { stricterTier, type ActionDef, type EscalationRule, type Tier } from "./types";

export type DecisionContext = {
  now: Date;
  /** How many times this action has previously been executed in this workspace. */
  priorExecutions: number;
};

export type TierDecision = {
  tier: Tier;
  /** Plain-language reasons shown to the approver. Empty when nothing escalated. */
  reasons: string[];
};

/** Owner override wins over the manifest default; `undo` needs connector support. */
export function baseTier(action: ActionDef, override: Tier | undefined): { tier: Tier; reasons: string[] } {
  const tier = override ?? action.tier;
  if (tier === "undo" && !action.undo) {
    return { tier: "ask", reasons: ["This action can't be undone, so we ask first."] };
  }
  return { tier, reasons: [] };
}

function countOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function hourIn(timezone: string, at: Date): number {
  try {
    const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: timezone }).format(at);
    return Number(hour);
  } catch {
    return at.getUTCHours();
  }
}

function inWindow(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Returns a reason if the rule fires, otherwise null. */
export function evaluateRule(
  rule: EscalationRule,
  input: Record<string, unknown>,
  ctx: DecisionContext,
): string | null {
  switch (rule.type) {
    case "max_items": {
      const count = countOf(input[rule.field]);
      if (count !== null && count > rule.max) {
        return `This affects ${count.toLocaleString("en-US")} (${rule.field}); the limit for running without asking is ${rule.max.toLocaleString("en-US")}.`;
      }
      return null;
    }
    case "first_time":
      return ctx.priorExecutions === 0 ? "This is the first time the AI is doing this." : null;
    case "quiet_hours": {
      const hour = hourIn(rule.timezone, ctx.now);
      return inWindow(hour, rule.from, rule.to)
        ? `It's outside working hours (${String(rule.from).padStart(2, "0")}:00–${String(rule.to).padStart(2, "0")}:00 is quiet time).`
        : null;
    }
  }
}

/**
 * Final tier for one invocation. Escalation can only make a decision stricter
 * (never → ask → undo → auto is impossible); a firing rule raises auto/undo to ask.
 */
export function decideTier(
  action: ActionDef,
  override: Tier | undefined,
  input: Record<string, unknown>,
  ctx: DecisionContext,
): TierDecision {
  const base = baseTier(action, override);
  if (base.tier === "never" || base.tier === "ask") return base;

  const fired = action.escalate
    .map((rule) => evaluateRule(rule, input, ctx))
    .filter((reason): reason is string => reason !== null);

  return fired.length > 0
    ? { tier: stricterTier(base.tier, "ask"), reasons: [...base.reasons, ...fired] }
    : base;
}

/** Fills `{field}` placeholders with input values; missing fields render as "…". */
export function renderSummary(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = input[key];
    if (value === undefined || value === null) return "…";
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  });
}
