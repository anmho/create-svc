import { afterEach, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp } from "../src/index";
import { DefaultChatService } from "../src/chat/service";
import { ChatRepository } from "../src/db/repository";
import { createDb } from "../src/db/client";
import type { AttachmentObjectMetadata, AttachmentUploadTarget } from "../src/chat/types";
import type { AttachmentStorage } from "../src/storage";

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
      webhook_events,
      attachments,
      messages,
      conversation_participants,
      conversations,
      users
    restart identity cascade
  `);
});

afterEach(async () => {
  await sql?.end();
  sql = null;
});

integrationTest("list messages returns newest-first pages with attachment metadata", async () => {
  Bun.env.ATTACHMENT_PUBLIC_BASE_URL = "https://storage.test";
  const storage = new FakeAttachmentStorage();
  const app = createApp(new DefaultChatService(new ChatRepository(createDb(databaseUrl)), storage, new NoopWebhookAdapter()));

  const user = await createUser(app);
  const conversation = await createConversation(app, user.id);
  const messageIds: string[] = [];

  for (let index = 1; index <= 55; index += 1) {
    const message = await createMessage(app, conversation.id, user.id, `message-${index}`);
    messageIds.push(message.id);
  }

  await rewriteMessageTimestamps(messageIds);

  const uploadResult = await requestJson(app, "/v1/attachments/uploads", {
    method: "POST",
    body: {
      conversation_id: conversation.id,
      user_id: user.id,
      filename: "photo.png",
      content_type: "image/png",
      byte_size: 1234,
    },
    expectedStatus: 201,
  });
  const attachment = uploadResult.result.attachment as {
    id: string;
    publicUrl: string;
    filename: string;
    contentType: string;
    byteSize: number;
    status: string;
  };

  storage.setObjectMetadataFromUrl(uploadResult.result.attachment.publicUrl, {
    contentType: "image/png",
    byteSize: 1234,
    publicUrl: uploadResult.result.attachment.publicUrl,
  });

  await requestJson(app, `/v1/attachments/${attachment.id}/finalize`, {
    method: "POST",
    body: {
      message_id: messageIds[54],
    },
  });

  const firstPage = await requestJson(app, `/v1/conversations/${conversation.id}/messages`);
  expect(firstPage.messages).toHaveLength(50);
  expect(firstPage.messages[0].body).toBe("message-55");
  expect(firstPage.messages[49].body).toBe("message-6");
  expect(firstPage.next_cursor).toBeString();
  expect(firstPage.messages[0].attachments).toEqual([
    {
      id: attachment.id,
      filename: "photo.png",
      content_type: "image/png",
      byte_size: 1234,
      status: "ready",
      public_url: attachment.publicUrl,
    },
  ]);

  const secondPage = await requestJson(
    app,
    `/v1/conversations/${conversation.id}/messages?cursor=${encodeURIComponent(firstPage.next_cursor)}`
  );
  expect(secondPage.messages.map((message: { body: string }) => message.body)).toEqual([
    "message-5",
    "message-4",
    "message-3",
    "message-2",
    "message-1",
  ]);
  expect(secondPage.next_cursor).toBeUndefined();

  const invalidLimit = await app.request(`/v1/conversations/${conversation.id}/messages?limit=0`);
  expect(invalidLimit.status).toBe(400);
  expect(await invalidLimit.json()).toEqual({
    error: "limit must be a positive integer",
    code: "invalid_limit",
  });

  const tooLargeLimit = await app.request(`/v1/conversations/${conversation.id}/messages?limit=101`);
  expect(tooLargeLimit.status).toBe(400);
  expect(await tooLargeLimit.json()).toEqual({
    error: "limit must be at most 100",
    code: "invalid_limit",
  });
});

async function createUser(app: ReturnType<typeof createApp>) {
  const response = await requestJson(app, "/v1/users", {
    method: "POST",
    body: {
      username: "alice",
      display_name: "Alice",
    },
    expectedStatus: 201,
  });
  return response.user as { id: string };
}

async function createConversation(app: ReturnType<typeof createApp>, createdByUserId: string) {
  const response = await requestJson(app, "/v1/conversations", {
    method: "POST",
    body: {
      created_by_user_id: createdByUserId,
      title: "General",
      participant_user_ids: [createdByUserId],
    },
    expectedStatus: 201,
  });
  return response.conversation as { id: string };
}

async function createMessage(app: ReturnType<typeof createApp>, conversationId: string, userId: string, body: string) {
  const response = await requestJson(app, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: {
      user_id: userId,
      body,
    },
    expectedStatus: 201,
  });
  return response.message as { id: string };
}

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

async function rewriteMessageTimestamps(messageIds: string[]) {
  if (!sql) {
    throw new Error("sql client not initialized");
  }

  const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
  for (const [index, messageId] of messageIds.entries()) {
    const createdAt = new Date(baseTime + (index + 1) * 1000).toISOString();
    await sql`
      update messages
      set created_at = ${createdAt}::timestamptz,
          updated_at = ${createdAt}::timestamptz
      where id = ${messageId}
    `;
  }
}

class FakeAttachmentStorage implements AttachmentStorage {
  private readonly metadata = new Map<string, AttachmentObjectMetadata>();

  async createSignedUpload(input: {
    attachmentId: string;
    conversationId: string;
    filename: string;
    contentType: string;
  }): Promise<{ bucket: string; key: string; upload: AttachmentUploadTarget; publicUrl: string }> {
    const bucket = "test-bucket";
    const key = `attachments/${input.conversationId}/${input.attachmentId}/${input.filename}`;
    const publicUrl = `https://storage.test/${key}`;
    return {
      bucket,
      key,
      upload: {
        method: "PUT",
        url: `https://uploads.test/${key}`,
        headers: { "Content-Type": input.contentType },
      },
      publicUrl,
    };
  }

  async getObjectMetadata(input: { bucket: string; key: string }) {
    const metadata = this.metadata.get(`${input.bucket}/${input.key}`);
    if (!metadata) {
      throw new Error(`missing metadata for ${input.bucket}/${input.key}`);
    }
    return metadata;
  }

  setObjectMetadataFromUrl(publicUrl: string, input: Omit<AttachmentObjectMetadata, "bucket" | "key">) {
    const [, bucketAndKey = ""] = publicUrl.split("https://storage.test/");
    this.metadata.set(`test-bucket/${bucketAndKey}`, {
      bucket: "test-bucket",
      key: bucketAndKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      publicUrl: input.publicUrl,
    });
  }
}

class NoopWebhookAdapter {
  async normalize() {
    return {
      provider: "generic",
      externalEventId: "evt_test",
      eventType: "generic.event",
      signatureValid: true,
      payloadJson: "{}",
    };
  }
}
