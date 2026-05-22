import { createDb } from "../db/client";
import { WaitlistRepository } from "../db/repository";
import type {
  JoinWaitlistInput,
  ListWaitlistEntriesInput,
  RecordTriggerInput,
  UpdateWaitlistEntryInput,
  WaitlistEntry,
  WaitlistEntryStatus,
} from "./types";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type WaitlistService = {
  joinWaitlist(input: JoinWaitlistInput): Promise<{ entry: WaitlistEntry; created: boolean }>;
  getWaitlistEntry(entryId: string): Promise<WaitlistEntry>;
  getWaitlistEntryByEmail(email: string): Promise<WaitlistEntry>;
  listWaitlistEntries(input?: ListWaitlistEntriesInput): Promise<WaitlistEntry[]>;
  updateWaitlistEntry(input: UpdateWaitlistEntryInput): Promise<WaitlistEntry>;
  exportWaitlistEntries(input?: ListWaitlistEntriesInput): Promise<string>;
  recordTrigger(input: RecordTriggerInput): Promise<unknown>;
};

export class DefaultWaitlistService implements WaitlistService {
  constructor(private readonly repository: WaitlistRepository) {}

  async joinWaitlist(input: JoinWaitlistInput) {
    const email = normalizeEmail(input.email);
    const existing = await this.repository.getEntryByEmail(email);
    if (existing) {
      return { entry: existing, created: false };
    }

    const entry = await this.repository.createEntry({
      id: crypto.randomUUID(),
      email,
      name: normalizeNullableText(input.name),
      company: normalizeNullableText(input.company),
      source: normalizeNullableText(input.source),
    });

    await this.repository.createTrigger({
      id: crypto.randomUUID(),
      type: "waitlist.joined",
      entryId: entry.id,
      payloadJson: JSON.stringify({ email: entry.email, source: entry.source }),
    });

    return { entry, created: true };
  }

  async getWaitlistEntry(entryId: string) {
    const entry = await this.repository.getEntryById(entryId.trim());
    if (!entry) {
      throw new AppError(404, "entry_not_found", `waitlist entry ${entryId} not found`);
    }
    return entry;
  }

  async getWaitlistEntryByEmail(email: string) {
    const entry = await this.repository.getEntryByEmail(normalizeEmail(email));
    if (!entry) {
      throw new AppError(404, "entry_not_found", `waitlist entry for ${email} not found`);
    }
    return entry;
  }

  async listWaitlistEntries(input: ListWaitlistEntriesInput = {}) {
    return this.repository.listEntries({
      status: input.status ? normalizeStatus(input.status) : null,
      limit: input.limit,
    });
  }

  async updateWaitlistEntry(input: UpdateWaitlistEntryInput) {
    const entryId = input.entryId.trim();
    if (!entryId) {
      throw new AppError(400, "invalid_entry_id", "entry id is required");
    }
    const entry = await this.repository.updateEntryStatus(entryId, normalizeStatus(input.status));
    if (!entry) {
      throw new AppError(404, "entry_not_found", `waitlist entry ${input.entryId} not found`);
    }
    return entry;
  }

  async exportWaitlistEntries(input: ListWaitlistEntriesInput = {}) {
    return entriesToCsv(await this.listWaitlistEntries(input));
  }

  async recordTrigger(input: RecordTriggerInput) {
    const type = input.type.trim();
    if (!type) {
      throw new AppError(400, "invalid_trigger_type", "trigger type is required");
    }

    if (input.entryId) {
      await this.getWaitlistEntry(input.entryId);
    }

    return this.repository.createTrigger({
      id: crypto.randomUUID(),
      type,
      entryId: input.entryId?.trim() || null,
      payloadJson: normalizePayloadJson(input.payloadJson),
    });
  }
}

export function createDefaultWaitlistService() {
  return new DefaultWaitlistService(new WaitlistRepository(createDb()));
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AppError(400, "invalid_email", "valid email is required");
  }
  return email;
}

function normalizeNullableText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeStatus(value: string): WaitlistEntryStatus {
  const status = value.trim().toLowerCase();
  if (status === "joined" || status === "invited" || status === "converted" || status === "archived") {
    return status;
  }
  throw new AppError(400, "invalid_status", "status must be one of joined, invited, converted, archived");
}

function entriesToCsv(entries: WaitlistEntry[]) {
  const headers = ["id", "email", "name", "company", "source", "status", "created_at", "updated_at"];
  return [
    headers.join(","),
    ...entries.map((entry) =>
      [
        entry.id,
        entry.email,
        entry.name ?? "",
        entry.company ?? "",
        entry.source ?? "",
        entry.status,
        entry.createdAt,
        entry.updatedAt,
      ]
        .map(csvCell)
        .join(",")
    ),
  ].join("\n");
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizePayloadJson(value: string | null | undefined) {
  const payload = value?.trim() || "{}";
  JSON.parse(payload);
  return payload;
}
