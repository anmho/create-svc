import { desc, eq } from "drizzle-orm";
import type { createDb } from "./client";
import { waitlistEntries, waitlistTriggers } from "./schema";
import type { WaitlistEntry, WaitlistTrigger } from "../waitlist/types";

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
  payloadJson: string;
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
        payloadJson: input.payloadJson,
        createdAt: new Date(),
      })
      .returning();
    return toWaitlistTrigger(row);
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
    payloadJson: row.payloadJson,
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}
