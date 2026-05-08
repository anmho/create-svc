import { afterEach, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDb } from "../src/db/client";
import { ChatRepository } from "../src/db/repository";
import { DefaultChatService } from "../src/chat/service";
import { createRpcService } from "../src/index";
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
  const rpc = createRpcService(new DefaultChatService(new ChatRepository(createDb(databaseUrl)), storage, new NoopWebhookAdapter()));

  const user = (await rpc.createUser!({ username: "alice", displayName: "Alice" } as any, undefined as never)).user!;
  const conversation = (
    await rpc.createConversation!({
      createdByUserId: user.id!,
      title: "General",
      participantUserIds: [user.id!],
    } as any, undefined as never)
  ).conversation!;

  const messageIds: string[] = [];
  for (let index = 1; index <= 55; index += 1) {
    const response = await rpc.createMessage!({
      conversationId: conversation.id!,
      userId: user.id!,
      body: `message-${index}`,
    } as any, undefined as never);
    messageIds.push(response.message!.id!);
  }
  await rewriteMessageTimestamps(messageIds);

  const uploadResult = await rpc.createAttachmentUpload!({
    conversationId: conversation.id!,
    userId: user.id!,
    filename: "photo.png",
    contentType: "image/png",
    byteSize: BigInt(1234),
  } as any, undefined as never);
  storage.setObjectMetadata(uploadResult.attachment!.publicUrl!, {
    contentType: "image/png",
    byteSize: 1234,
    publicUrl: uploadResult.attachment!.publicUrl!,
  });
  await rpc.finalizeAttachment!({
    attachmentId: uploadResult.attachment!.id!,
    messageId: messageIds[54]!,
  } as any, undefined as never);

  const firstPage = await rpc.listMessages!({
    conversationId: conversation.id!,
  } as any, undefined as never);
  expect(firstPage.messages!).toHaveLength(50);
  expect(firstPage.messages![0]?.body).toBe("message-55");
  expect(firstPage.messages![49]?.body).toBe("message-6");
  expect(firstPage.nextCursor).toBeString();
  expect(firstPage.messages![0]?.attachments).toEqual([
    {
      id: uploadResult.attachment!.id!,
      filename: "photo.png",
      contentType: "image/png",
      byteSize: BigInt(1234),
      status: "ready",
      publicUrl: uploadResult.attachment!.publicUrl!,
    },
  ]);

  const secondPage = await rpc.listMessages!({
    conversationId: conversation.id!,
    cursor: firstPage.nextCursor,
  } as any, undefined as never);
  expect(secondPage.messages!.map((message) => message.body)).toEqual([
    "message-5",
    "message-4",
    "message-3",
    "message-2",
    "message-1",
  ]);
  expect(secondPage.nextCursor).toBe("");
});

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

  setObjectMetadata(publicUrl: string, input: Omit<AttachmentObjectMetadata, "bucket" | "key">) {
    const [, key = ""] = publicUrl.split("https://storage.test/");
    this.metadata.set(`test-bucket/${key}`, {
      bucket: "test-bucket",
      key,
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
