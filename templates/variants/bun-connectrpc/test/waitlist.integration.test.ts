import { afterEach, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDb } from "../src/db/client";
import { WaitlistRepository } from "../src/db/repository";
import { DefaultWaitlistService } from "../src/waitlist/service";
import { createRpcService } from "../src/index";

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

integrationTest("waitlist rpc join is idempotent and records triggers", async () => {
  const rpc = createRpcService(new DefaultWaitlistService(new WaitlistRepository(createDb(databaseUrl))));

  const first = await rpc.joinWaitlist!({
    email: "Founder@Example.com",
    name: "Founder",
    company: "Example Co",
    source: "homepage",
  } as any, undefined as never);
  expect(first.created).toBe(true);
  expect(first.entry!.email).toBe("founder@example.com");

  const second = await rpc.joinWaitlist!({ email: "founder@example.com" } as any, undefined as never);
  expect(second.created).toBe(false);
  expect(second.entry!.id).toBe(first.entry!.id);

  const trigger = await rpc.recordTrigger!({
    type: "cron.digest",
    entryId: first.entry!.id,
    payloadJson: "{}",
  } as any, undefined as never);
  expect(trigger.trigger).toMatchObject({
    type: "cron.digest",
    entryId: first.entry!.id,
    status: "queued",
  });

  const updated = await rpc.updateWaitlistEntry!({
    entryId: first.entry!.id,
    status: "invited",
  } as any, undefined as never);
  expect(updated.entry).toMatchObject({ id: first.entry!.id, status: "invited" });

  const list = await rpc.listWaitlistEntries!({ status: "invited" } as any, undefined as never);
  const entries = list.entries ?? [];
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ id: first.entry!.id, status: "invited" });

  const exported = await rpc.exportWaitlistEntries!({ status: "invited" } as any, undefined as never);
  expect(exported.csv).toContain("founder@example.com");
});
