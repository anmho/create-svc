import { afterEach, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp } from "../src/index";
import { DefaultWaitlistService } from "../src/waitlist/service";
import { WaitlistRepository } from "../src/db/repository";
import { createDb } from "../src/db/client";

const databaseUrl = Bun.env.DATABASE_URL?.trim();
const integrationTest = databaseUrl ? test : test.skip;

let sql: SQL | null = null;

beforeEach(async () => {
  if (!databaseUrl) {
    return;
  }
  sql = new SQL(databaseUrl);
  await sql.unsafe(`
    truncate table
      waitlist_triggers,
      waitlist_entries
    restart identity cascade
  `);
});

afterEach(async () => {
  await sql?.end();
  sql = null;
});

integrationTest("waitlist join is idempotent and records triggers", async () => {
  const app = createApp(new DefaultWaitlistService(new WaitlistRepository(createDb(databaseUrl))));

  const first = await requestJson(app, "/v1/waitlist", {
    method: "POST",
    body: {
      email: "Founder@Example.com",
      name: "Founder",
      company: "Example Co",
      source: "homepage",
    },
    expectedStatus: 201,
  });
  expect(first.entry.email).toBe("founder@example.com");
  expect(first.created).toBe(true);

  const second = await requestJson(app, "/v1/waitlist", {
    method: "POST",
    body: {
      email: "founder@example.com",
    },
  });
  expect(second.entry.id).toBe(first.entry.id);
  expect(second.created).toBe(false);

  const trigger = await requestJson(app, "/v1/triggers/waitlist", {
    method: "POST",
    body: {
      type: "cron.digest",
      entry_id: first.entry.id,
    },
    expectedStatus: 202,
  });
  expect(trigger.trigger).toMatchObject({
    type: "cron.digest",
    entryId: first.entry.id,
    status: "queued",
  });

  const updated = await requestJson(app, `/v1/admin/waitlist/${first.entry.id}`, {
    method: "PATCH",
    body: { status: "invited" },
  });
  expect(updated.entry).toMatchObject({ id: first.entry.id, status: "invited" });

  const list = await requestJson(app, "/v1/admin/waitlist?status=invited");
  expect(list.entries).toHaveLength(1);
  expect(list.entries[0]).toMatchObject({ id: first.entry.id, status: "invited" });

  const exportResponse = await app.request("/v1/admin/waitlist/export?status=invited");
  expect(exportResponse.status).toBe(200);
  expect(exportResponse.headers.get("content-type")).toContain("text/csv");
  expect(await exportResponse.text()).toContain("founder@example.com");
});

async function requestJson(
  app: ReturnType<typeof createApp>,
  path: string,
  input: {
    method?: string;
    body?: unknown;
    expectedStatus?: number;
  } = {}
) {
  const response = await app.request(path, {
    method: input.method ?? "GET",
    headers: input.body ? { "Content-Type": "application/json" } : undefined,
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  expect(response.status).toBe(input.expectedStatus ?? 200);
  return response.json();
}
