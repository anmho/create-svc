export type WaitlistEntry = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  source: string | null;
  status: WaitlistEntryStatus;
  createdAt: string;
  updatedAt: string;
};

export type WaitlistTrigger = {
  id: string;
  type: string;
  entryId: string | null;
  status: "queued" | "processed" | "failed";
  payloadJson: string;
  createdAt: string;
  processedAt: string | null;
};

export type WebhookEvent = {
  id: string;
  provider: string;
  externalEventId: string;
  payload: unknown;
  headers: Record<string, string>;
  receivedAt: string;
};

export type JoinWaitlistInput = {
  email: string;
  name?: string | null;
  company?: string | null;
  source?: string | null;
};

export type WaitlistEntryStatus = "joined" | "invited" | "converted" | "archived";

export type ListWaitlistEntriesInput = {
  status?: string | null;
  limit?: number | null;
};

export type UpdateWaitlistEntryInput = {
  entryId: string;
  status: string;
};

export type RecordTriggerInput = {
  type: string;
  entryId?: string | null;
  payloadJson?: string | null;
};

export type RecordWebhookEventInput = {
  provider: string;
  externalEventId: string;
  payload: unknown;
  headers: Record<string, string>;
};
