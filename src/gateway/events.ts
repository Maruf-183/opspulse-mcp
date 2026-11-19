import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { gatewayEvents } from "@/db/schema";
import { canonicalJson, sha256 } from "./hashing";

export const GENESIS_HASH = "0".repeat(64);

export type NewEvent = {
  sandboxId: string;
  projectId?: string | null;
  requestId?: string | null;
  kind: string;
  summary: string;
  actor: string;
  data?: Record<string, unknown>;
};

type ChainedFields = Omit<NewEvent, "data"> & { data: Record<string, unknown>; createdAt: string; prevHash: string };

/** The hash covers every stored field plus the previous hash. */
export function eventHash(fields: ChainedFields): string {
  return sha256(
    canonicalJson({
      sandboxId: fields.sandboxId,
      projectId: fields.projectId ?? null,
      requestId: fields.requestId ?? null,
      kind: fields.kind,
      summary: fields.summary,
      actor: fields.actor,
      data: fields.data,
      createdAt: fields.createdAt,
      prevHash: fields.prevHash,
    }),
  );
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ??
    (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/**
 * Appends to the workspace's hash chain. Two concurrent appends that read the
 * same head collide on the unique (sandbox_id, prev_hash) index; the loser
 * re-reads the head and retries.
 */
export async function appendEvent(event: NewEvent): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [head] = await db
      .select({ hash: gatewayEvents.hash })
      .from(gatewayEvents)
      .where(eq(gatewayEvents.sandboxId, event.sandboxId))
      .orderBy(desc(gatewayEvents.id))
      .limit(1);

    // Millisecond precision survives the timestamp column round-trip.
    const createdAt = new Date(Math.floor(Date.now()));
    const fields: ChainedFields = {
      ...event,
      projectId: event.projectId ?? null,
      requestId: event.requestId ?? null,
      data: event.data ?? {},
      createdAt: createdAt.toISOString(),
      prevHash: head?.hash ?? GENESIS_HASH,
    };

    try {
      await db.insert(gatewayEvents).values({
        sandboxId: fields.sandboxId,
        projectId: fields.projectId,
        requestId: fields.requestId,
        kind: fields.kind,
        summary: fields.summary,
        actor: fields.actor,
        data: fields.data,
        prevHash: fields.prevHash,
        hash: eventHash(fields),
        createdAt,
      });
      return;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 4) throw error;
    }
  }
}

export type ChainCheck = { valid: true; count: number } | { valid: false; count: number; brokenAtId: number };

/** Recomputes every hash in order. Any edited, removed or reordered event is detected. */
export function verifyChain(
  rows: Array<typeof gatewayEvents.$inferSelect>,
): ChainCheck {
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const expected = eventHash({
      sandboxId: row.sandboxId,
      projectId: row.projectId,
      requestId: row.requestId,
      kind: row.kind,
      summary: row.summary,
      actor: row.actor,
      data: (row.data ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      prevHash: row.prevHash,
    });
    if (row.prevHash !== prev || row.hash !== expected) {
      return { valid: false, count: rows.length, brokenAtId: row.id };
    }
    prev = row.hash;
  }
  return { valid: true, count: rows.length };
}

export async function verifyWorkspaceChain(sandboxId: string): Promise<ChainCheck> {
  const rows = await db
    .select()
    .from(gatewayEvents)
    .where(and(eq(gatewayEvents.sandboxId, sandboxId)))
    .orderBy(asc(gatewayEvents.id));
  return verifyChain(rows);
}
