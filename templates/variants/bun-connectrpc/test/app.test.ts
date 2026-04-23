import { expect, test } from "bun:test";
import { handleRequest } from "../src/index";

test("connect-style ping route responds", async () => {
  const response = await handleRequest(
    new Request("http://localhost/rpc.example.v1.Service/Ping", {
      method: "POST",
      body: JSON.stringify({ name: "preview" }),
      headers: {
        "Content-Type": "application/json",
      },
    })
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ message: "hello preview" });
});
