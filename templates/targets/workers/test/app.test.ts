import { expect, test } from "bun:test";
import { createApp } from "../src/index";

type JoinResponse = {
  entry: {
    id: string;
    email: string;
    name?: string | null;
    source?: string | null;
    status?: string;
  };
  created: boolean;
};

test("health endpoint returns ok", async () => {
  const response = await createApp().request("/healthz");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

test("waitlist join persists an idempotent entry", async () => {
  const app = createApp();
  const response = await app.request("/v1/waitlist", {
    method: "POST",
    body: JSON.stringify({ email: "Workers@Example.com", name: "Workers Example" }),
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(201);
  const created = (await response.json()) as JoinResponse;
  expect(created).toMatchObject({
    entry: {
      email: "workers@example.com",
      name: "Workers Example",
      status: "joined",
    },
    created: true,
  });

  const duplicate = await app.request("/v1/waitlist", {
    method: "POST",
    body: JSON.stringify({ email: "workers@example.com", source: "repeat" }),
    headers: { "content-type": "application/json" },
  });
  expect(duplicate.status).toBe(200);
  await expect(duplicate.json()).resolves.toMatchObject({
    entry: {
      id: created.entry.id,
      email: "workers@example.com",
      source: "repeat",
    },
    created: false,
  });

  const lookup = await app.request("/v1/waitlist?email=workers@example.com");
  expect(lookup.status).toBe(200);
  await expect(lookup.json()).resolves.toMatchObject({
    entry: {
      id: created.entry.id,
      email: "workers@example.com",
    },
  });

  const updated = await app.request(`/v1/admin/waitlist/${created.entry.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "invited" }),
    headers: { "content-type": "application/json" },
  });
  expect(updated.status).toBe(200);
  await expect(updated.json()).resolves.toMatchObject({
    entry: {
      id: created.entry.id,
      status: "invited",
    },
  });

  const list = await app.request("/v1/admin/waitlist?status=invited");
  expect(list.status).toBe(200);
  await expect(list.json()).resolves.toMatchObject({
    entries: [
      {
        id: created.entry.id,
        email: "workers@example.com",
      },
    ],
  });

  const exported = await app.request("/v1/admin/waitlist/export?status=invited");
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-type")).toContain("text/csv");
  expect(await exported.text()).toContain("workers@example.com");
});

test("waitlist trigger is queued for cron processing", async () => {
  const response = await createApp().request("/v1/triggers/waitlist", {
    method: "POST",
    body: JSON.stringify({ type: "cron.digest" }),
    headers: { "content-type": "application/json" },
  });

  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toMatchObject({
    trigger: {
      type: "cron.digest",
      status: "queued",
    },
  });
});
