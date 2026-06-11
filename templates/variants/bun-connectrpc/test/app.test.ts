import { expect, test } from "bun:test";
import { createIntrospectionDocument, isLocalRpcIntrospectionEnabled } from "@/index";
import { assertTemporalRuntimeConfig, resolveTemporalRuntimeConfig } from "@/temporal";

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

test("Temporal runtime config defaults to enabled local development", () => {
  expect(resolveTemporalRuntimeConfig({})).toEqual({
    enabled: true,
    address: "localhost:7233",
    namespace: "default",
    taskQueue: "{{SERVICE_NAME}}",
  });
});

test("Temporal runtime config supports explicit opt-out", () => {
  expect(resolveTemporalRuntimeConfig({ TEMPORAL_ENABLED: "false", K_SERVICE: "svc" })).toMatchObject({
    enabled: false,
  });
});

test("Temporal runtime config fails clearly in Cloud Run without connection settings", () => {
  expect(() => assertTemporalRuntimeConfig(resolveTemporalRuntimeConfig({ K_SERVICE: "svc" }))).toThrow(
    "TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE"
  );
});
