import { expect, test } from "bun:test";
import { createApp } from "../src/index";
import type { WaitlistService } from "../src/waitlist/service";
import type { WaitlistEntry } from "../src/waitlist/types";

test("health endpoint returns ok", async () => {
  const response = await createApp(createMockService()).request("/healthz");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("webhook health endpoint returns ok", async () => {
  const response = await createApp(createMockService()).request("/webhooks/generic/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", provider: "generic" });
});

test("waitlist join returns created entry", async () => {
  const response = await createApp(createMockService()).request("/v1/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "founder@example.com", source: "test" }),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    created: true,
    entry: {
      email: "founder@example.com",
      status: "joined",
    },
  });
});

test("waitlist api requires a bearer token when service auth is enabled", async () => {
  const previous = Bun.env.AUTH_ENABLED;
  Bun.env.AUTH_ENABLED = "true";
  try {
    const response = await createApp(createMockService()).request("/v1/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "founder@example.com" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing bearer token", code: "unauthorized" });
  } finally {
    if (previous === undefined) {
      delete Bun.env.AUTH_ENABLED;
    } else {
      Bun.env.AUTH_ENABLED = previous;
    }
  }
});

function createMockService(): WaitlistService {
  const entry: WaitlistEntry = {
    id: "entry_1",
    email: "founder@example.com",
    name: null,
    company: null,
    source: "test",
    status: "joined",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  return {
    async joinWaitlist() {
      return { entry, created: true };
    },
    async getWaitlistEntry() {
      return entry;
    },
    async getWaitlistEntryByEmail() {
      return entry;
    },
    async listWaitlistEntries() {
      return [entry];
    },
    async updateWaitlistEntry() {
      return { ...entry, status: "invited" };
    },
    async exportWaitlistEntries() {
      return "id,email,name,company,source,status,created_at,updated_at\nentry_1,founder@example.com,,,test,joined,2026-01-01T00:00:00.000Z,2026-01-01T00:00:00.000Z";
    },
    async recordTrigger() {
      return {
        id: "trigger_1",
        type: "manual",
        entryId: null,
        status: "queued",
        payload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        processedAt: null,
      };
    },
    async recordWebhookEvent() {
      return {
        duplicate: false,
        event: {
          id: "webhook_1",
          provider: "generic",
          externalEventId: "evt_1",
          payload: {},
          headers: {},
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    },
  };
}
