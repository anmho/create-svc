import { expect, test } from "bun:test";
import { createApp } from "../src/index";
import type { ChatService } from "../src/chat/service";

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

function createMockService(): ChatService {
  return {
    async createUser() {
      throw new Error("not implemented");
    },
    async getUser() {
      throw new Error("not implemented");
    },
    async getUserByUsername() {
      throw new Error("not implemented");
    },
    async createConversation() {
      throw new Error("not implemented");
    },
    async getConversation() {
      throw new Error("not implemented");
    },
    async updateConversation() {
      throw new Error("not implemented");
    },
    async deleteConversation() {},
    async addParticipant() {
      throw new Error("not implemented");
    },
    async removeParticipant() {},
    async listMessages() {
      return { messages: [] };
    },
    async createMessage() {
      throw new Error("not implemented");
    },
    async updateMessage() {
      throw new Error("not implemented");
    },
    async deleteMessage() {},
    async createAttachmentUpload() {
      throw new Error("not implemented");
    },
    async finalizeAttachment() {
      throw new Error("not implemented");
    },
    async getAttachment() {
      throw new Error("not implemented");
    },
    async deleteAttachment() {},
    async processWebhook() {
      throw new Error("not implemented");
    },
  };
}
