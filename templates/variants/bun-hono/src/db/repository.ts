import { and, desc, eq } from "drizzle-orm";
import type { createDb } from "./client";
import { waitlistEntries, waitlistTriggers, webhookEvents } from "./schema";
import type { WaitlistEntry, WaitlistTrigger, WebhookEvent } from "../waitlist/types";

type Database = ReturnType<typeof createDb>;
type WaitlistEntryRow = typeof waitlistEntries.$inferSelect;

type CreateEntryRecord = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  source: string | null;
};

type CreateTriggerRecord = {
  id: string;
  type: string;
  entryId: string | null;
  payload: unknown;
};

type CreateWebhookEventRecord = {
  id: string;
  provider: string;
  externalEventId: string;
  payload: unknown;
  headers: Record<string, string>;
};

export class WaitlistRepository {
  constructor(private readonly db: Database) {}

  async createEntry(input: CreateEntryRecord): Promise<WaitlistEntry> {
    const now = new Date();
    const [row] = await this.db
      .insert(waitlistEntries)
      .values({
        id: input.id,
        email: input.email,
        name: input.name,
        company: input.company,
        source: input.source,
        status: "joined",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toWaitlistEntry(row);
  }

  async getEntryById(entryId: string): Promise<WaitlistEntry | null> {
    const [row] = await this.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).limit(1);
    return row ? toWaitlistEntry(row) : null;
  }

  async getEntryByEmail(email: string): Promise<WaitlistEntry | null> {
    const [row] = await this.db.select().from(waitlistEntries).where(eq(waitlistEntries.email, email)).limit(1);
    return row ? toWaitlistEntry(row) : null;
  }

  async listEntries(input: { status?: string | null; limit?: number | null } = {}): Promise<WaitlistEntry[]> {
    const limit = clampLimit(input.limit);
    const rows = input.status
      ? await this.db
          .select()
          .from(waitlistEntries)
          .where(eq(waitlistEntries.status, input.status as WaitlistEntryRow["status"]))
          .orderBy(desc(waitlistEntries.createdAt))
          .limit(limit)
      : await this.db.select().from(waitlistEntries).orderBy(desc(waitlistEntries.createdAt)).limit(limit);
    return rows.map(toWaitlistEntry);
  }

  async updateEntryStatus(entryId: string, status: WaitlistEntryRow["status"]): Promise<WaitlistEntry | null> {
    const [row] = await this.db
      .update(waitlistEntries)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(waitlistEntries.id, entryId))
      .returning();
    return row ? toWaitlistEntry(row) : null;
  }

  async createTrigger(input: CreateTriggerRecord): Promise<WaitlistTrigger> {
    const [row] = await this.db
      .insert(waitlistTriggers)
      .values({
        id: input.id,
        type: input.type,
        entryId: input.entryId,
        status: "queued",
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: new Date(),
      })
      .returning();
    return toWaitlistTrigger(row);
  }

  async recordWebhookEvent(input: CreateWebhookEventRecord): Promise<{ event: WebhookEvent; duplicate: boolean }> {
    const [inserted] = await this.db
      .insert(webhookEvents)
      .values({
        id: input.id,
        provider: input.provider,
        externalEventId: input.externalEventId,
        payloadJson: JSON.stringify(input.payload ?? {}),
        headersJson: JSON.stringify(input.headers),
        receivedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.externalEventId],
      })
      .returning();
    if (inserted) {
      return { event: toWebhookEvent(inserted), duplicate: false };
    }

    const [row] = await this.db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, input.provider), eq(webhookEvents.externalEventId, input.externalEventId)))
      .limit(1);
    if (!row) {
      throw new Error("webhook event was not inserted and could not be read");
    }
    return { event: toWebhookEvent(row), duplicate: true };
  }
}

function clampLimit(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) {
    return 100;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 500);
}

function toWaitlistEntry(row: WaitlistEntryRow): WaitlistEntry {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    company: row.company,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWaitlistTrigger(row: typeof waitlistTriggers.$inferSelect): WaitlistTrigger {
  return {
    id: row.id,
    type: row.type,
    entryId: row.entryId,
    status: row.status,
    payload: JSON.parse(row.payloadJson),
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

function toWebhookEvent(row: typeof webhookEvents.$inferSelect): WebhookEvent {
  return {
    id: row.id,
    provider: row.provider,
    externalEventId: row.externalEventId,
    payload: JSON.parse(row.payloadJson),
    headers: JSON.parse(row.headersJson),
    receivedAt: row.receivedAt.toISOString(),
  };
}
