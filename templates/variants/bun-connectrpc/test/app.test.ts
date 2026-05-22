import { expect, test } from "bun:test";
import { createIntrospectionDocument, isLocalRpcIntrospectionEnabled } from "../src/index";

test("local introspection document exposes waitlist service and methods", () => {
  const document = createIntrospectionDocument();

  expect(document.service).toBe("waitlist.v1.WaitlistService");
  expect(document.methods.map((method) => method.name)).toContain("JoinWaitlist");
  expect(document.methods.map((method) => method.name)).toContain("RecordTrigger");
});

test("local introspection defaults to enabled outside Cloud Run", () => {
  delete Bun.env.K_SERVICE;
  delete Bun.env.ENABLE_RPC_INTROSPECTION;
  Bun.env.NODE_ENV = "development";

  expect(isLocalRpcIntrospectionEnabled()).toBeTrue();
});
