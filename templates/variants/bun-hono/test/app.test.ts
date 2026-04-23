import { expect, test } from "bun:test";
import { createApp } from "../src/index";

test("health endpoint returns ok", async () => {
  const response = await createApp().request("/healthz");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "ok",
    runtime: "bun",
    framework: "hono",
  });
});
