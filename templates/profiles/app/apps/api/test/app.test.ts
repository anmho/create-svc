import { expect, test } from "bun:test";
import { createIntrospectionDocument, isLocalRpcIntrospectionEnabled } from "../src/index";

test("local introspection document exposes chat service and methods", () => {
  const document = createIntrospectionDocument();

  expect(document.service).toBe("chat.v1.ChatService");
  expect(document.methods.map((method) => method.name)).toContain("CreateUser");
  expect(document.methods.map((method) => method.name)).toContain("CreateAttachmentUpload");
});

test("local introspection defaults to enabled outside Cloud Run", () => {
  delete Bun.env.K_SERVICE;
  delete Bun.env.ENABLE_RPC_INTROSPECTION;
  Bun.env.NODE_ENV = "development";

  expect(isLocalRpcIntrospectionEnabled()).toBeTrue();
});
