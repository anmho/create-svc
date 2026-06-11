import { expect, test } from "bun:test";
import { createApp, createIntrospectionDocument, createRpcService } from "@/index";
import { AppError, type WaitlistService } from "@/waitlist/service";
import type { WaitlistEntry } from "@/waitlist/types";

const baseEntry: WaitlistEntry = {
  id: "entry-1",
  email: "workers@example.com",
  name: "Workers Example",
  company: null,
  source: null,
  status: "joined",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function stubService(overrides: Partial<WaitlistService> = {}): WaitlistService {
  return {
    async joinWaitlist(input) {
      return { entry: { ...baseEntry, email: input.email.trim().toLowerCase() }, created: true };
    },
    async getWaitlistEntry(entryId) {
      if (entryId !== baseEntry.id) {
        throw new AppError(404, "not_found", "waitlist entry not found");
      }
      return baseEntry;
    },
    async getWaitlistEntryByEmail() {
      return baseEntry;
    },
    async listWaitlistEntries() {
      return [baseEntry];
    },
    async updateWaitlistEntry() {
      return baseEntry;
    },
    async exportWaitlistEntries() {
      return "id,email\n";
    },
    async recordTrigger(input) {
      return {
        id: "trigger-1",
        type: input.type,
        entryId: input.entryId ?? null,
        status: "queued" as const,
        payloadJson: input.payloadJson ?? "{}",
        createdAt: baseEntry.createdAt,
        processedAt: null,
      };
    },
    async recordWebhookEvent(input) {
      return {
        event: {
          id: "event-1",
          provider: input.provider,
          externalEventId: input.externalEventId,
          payload: input.payload,
          headers: input.headers,
          receivedAt: baseEntry.createdAt,
        },
        duplicate: false,
      };
    },
    ...overrides,
  };
}

function appWithStub(overrides: Partial<WaitlistService> = {}) {
  return createApp({
    serviceFactory: async () => ({ service: stubService(overrides) }),
  });
}

test("health endpoint returns ok", async () => {
  const response = await createApp().request("/healthz");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

test("metrics endpoint returns text", async () => {
  const response = await createApp().request("/metrics");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
});

test("join waitlist over the Connect protocol", async () => {
  const response = await appWithStub().request("/waitlist.v1.WaitlistService/JoinWaitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "Workers@Example.com" }),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { entry: { email: string }; created: boolean };
  expect(body.created).toBeTrue();
  expect(body.entry.email).toBe("workers@example.com");
});

test("unknown RPC methods return 404", async () => {
  const response = await appWithStub().request("/waitlist.v1.WaitlistService/DoesNotExist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(404);
});

test("rpc errors surface as Connect errors", async () => {
  const app = appWithStub({
    async getWaitlistEntry() {
      throw new AppError(404, "not_found", "waitlist entry not found");
    },
  });
  const response = await app.request("/waitlist.v1.WaitlistService/GetWaitlistEntry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entryId: "missing" }),
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
});

test("introspection document lists waitlist methods and is gated by env", async () => {
  const document = createIntrospectionDocument();
  expect(document.service).toBe("waitlist.v1.WaitlistService");
  expect(document.methods.map((method) => method.name)).toContain("JoinWaitlist");

  const hidden = await appWithStub().request("/debug/connectrpc");
  expect(hidden.status).toBe(404);

  const app = appWithStub();
  const shown = await app.request("/debug/connectrpc", {}, { ENABLE_RPC_INTROSPECTION: "true" });
  expect(shown.status).toBe(200);
});

test("createRpcService maps trigger records", async () => {
  const rpc = createRpcService(stubService());
  const result = await rpc.recordTrigger?.(
    { type: "manual", entryId: "", payloadJson: "{}" } as never,
    {} as never
  );
  expect(result?.trigger?.type).toBe("manual");
});

test("webhook delivery records event and trigger", async () => {
  const app = appWithStub();
  const response = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "evt_1", kind: "test" }),
  });
  expect(response.status).toBe(202);
  const body = (await response.json()) as { duplicate: boolean };
  expect(body.duplicate).toBeFalse();
});

test("internal Trigger.dev callback records a trigger", async () => {
  const app = appWithStub();
  const response = await app.request("/internal/trigger/waitlist-follow-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entryId: baseEntry.id }),
  });
  expect(response.status).toBe(202);
  const body = (await response.json()) as { trigger: { type: string; entryId: string } };
  expect(body.trigger.type).toBe("trigger.waitlist_follow_up");
  expect(body.trigger.entryId).toBe(baseEntry.id);
});
