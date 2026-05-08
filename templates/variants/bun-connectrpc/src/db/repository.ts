import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { createDb } from "./client";
import { attachments, conversationParticipants, conversations, messages, users, webhookEvents } from "./schema";
import type {
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  ChatMessageAttachment,
  ChatUser,
  NormalizedWebhookEvent,
  WebhookEventRecord,
} from "../chat/types";

type Database = ReturnType<typeof createDb>;

type CreateUserRecord = {
  id: string;
  username: string;
  displayName: string | null | undefined;
};

type CreateConversationRecord = {
  id: string;
  title: string | null | undefined;
  createdByUserId: string;
  participantUserIds: string[];
};

type CreateMessageRecord = {
  id: string;
  conversationId: string;
  userId: string;
  body: string;
};

type CreateAttachmentRecord = {
  id: string;
  conversationId: string;
  uploadedByUserId: string;
  storageBucket: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  filename: string;
};

type ListMessagesCursor = {
  createdAt: string;
  id: string;
};

type ListMessagesPage = {
  messages: ChatMessage[];
  hasMore: boolean;
};

export class ChatRepository {
  constructor(private readonly db: Database) {}

  async createUser(input: CreateUserRecord): Promise<ChatUser> {
    const now = new Date();
    const [row] = await this.db
      .insert(users)
      .values({
        id: input.id,
        username: input.username,
        displayName: input.displayName ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toChatUser(row);
  }

  async getUserById(userId: string): Promise<ChatUser | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row ? toChatUser(row) : null;
  }

  async getUserByUsername(username: string): Promise<ChatUser | null> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return row ? toChatUser(row) : null;
  }

  async listUsersByIds(userIds: string[]): Promise<ChatUser[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.db.select().from(users).where(inArray(users.id, userIds));
    return rows.map(toChatUser);
  }

  async createConversation(input: CreateConversationRecord): Promise<ChatConversation> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: input.id,
        title: input.title ?? null,
        createdByUserId: input.createdByUserId,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(conversationParticipants).values(
        input.participantUserIds.map((userId) => ({
          conversationId: input.id,
          userId,
          joinedAt: now,
        }))
      );
    });

    return this.getConversationByIdOrThrow(input.id);
  }

  async getConversationById(conversationId: string): Promise<ChatConversation | null> {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)))
      .limit(1);

    if (!conversation) {
      return null;
    }

    const participantRows = await this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(conversationParticipants)
      .innerJoin(users, eq(conversationParticipants.userId, users.id))
      .where(eq(conversationParticipants.conversationId, conversationId))
      .orderBy(asc(users.username));

    return {
      id: conversation.id,
      title: conversation.title,
      createdByUserId: conversation.createdByUserId,
      participants: participantRows.map(toChatUser),
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }

  async updateConversation(conversationId: string, title: string | null | undefined): Promise<ChatConversation> {
    await this.db
      .update(conversations)
      .set({
        title: title ?? null,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    return this.getConversationByIdOrThrow(conversationId);
  }

  async softDeleteConversation(conversationId: string) {
    const now = new Date();
    await this.db
      .update(conversations)
      .set({
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(conversations.id, conversationId));
  }

  async addParticipant(conversationId: string, userId: string) {
    const [existing] = await this.db
      .select()
      .from(conversationParticipants)
      .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId)))
      .limit(1);

    if (!existing) {
      await this.db.insert(conversationParticipants).values({
        conversationId,
        userId,
        joinedAt: new Date(),
      });
    }
  }

  async removeParticipant(conversationId: string, userId: string) {
    await this.db
      .delete(conversationParticipants)
      .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId)));
  }

  async listMessages(
    conversationId: string,
    input: {
      limit: number;
      cursor?: ListMessagesCursor;
    }
  ): Promise<ListMessagesPage> {
    const predicate = input.cursor
      ? and(
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
          or(
            lt(messages.createdAt, new Date(input.cursor.createdAt)),
            and(eq(messages.createdAt, new Date(input.cursor.createdAt)), lt(messages.id, input.cursor.id))
          )
        )
      : and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt));

    const rows = await this.db
      .select()
      .from(messages)
      .where(predicate)
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const attachmentMap = await this.listReadyAttachmentsByMessageIds(pageRows.map((row) => row.id));

    return {
      messages: pageRows.map((row) => toChatMessage(row, attachmentMap.get(row.id) ?? [])),
      hasMore,
    };
  }

  async createMessage(input: CreateMessageRecord): Promise<ChatMessage> {
    const now = new Date();
    const [row] = await this.db
      .insert(messages)
      .values({
        id: input.id,
        conversationId: input.conversationId,
        userId: input.userId,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toChatMessage(row, []);
  }

  async getMessageById(messageId: string): Promise<ChatMessage | null> {
    const [row] = await this.db.select().from(messages).where(and(eq(messages.id, messageId), isNull(messages.deletedAt))).limit(1);
    return row ? toChatMessage(row, []) : null;
  }

  async updateMessage(messageId: string, body: string): Promise<ChatMessage> {
    const now = new Date();
    const [row] = await this.db
      .update(messages)
      .set({
        body,
        editedAt: now,
        updatedAt: now,
      })
      .where(eq(messages.id, messageId))
      .returning();
    return toChatMessage(row, []);
  }

  async softDeleteMessage(messageId: string) {
    const now = new Date();
    await this.db
      .update(messages)
      .set({
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(messages.id, messageId));
  }

  async createAttachment(input: CreateAttachmentRecord): Promise<ChatAttachment> {
    const now = new Date();
    const [row] = await this.db
      .insert(attachments)
      .values({
        id: input.id,
        conversationId: input.conversationId,
        uploadedByUserId: input.uploadedByUserId,
        storageBucket: input.storageBucket,
        storageKey: input.storageKey,
        contentType: input.contentType,
        byteSize: input.byteSize,
        filename: input.filename,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toChatAttachment(row);
  }

  async getAttachmentById(attachmentId: string): Promise<ChatAttachment | null> {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), isNull(attachments.deletedAt)))
      .limit(1);
    return row ? toChatAttachment(row) : null;
  }

  async finalizeAttachment(attachmentId: string, input: { messageId: string | null; contentType: string; byteSize: number }) {
    const [row] = await this.db
      .update(attachments)
      .set({
        messageId: input.messageId,
        contentType: input.contentType,
        byteSize: input.byteSize,
        status: "ready",
        updatedAt: new Date(),
      })
      .where(eq(attachments.id, attachmentId))
      .returning();
    return toChatAttachment(row);
  }

  async softDeleteAttachment(attachmentId: string) {
    const now = new Date();
    await this.db
      .update(attachments)
      .set({
        deletedAt: now,
        status: "deleted",
        updatedAt: now,
      })
      .where(eq(attachments.id, attachmentId));
  }

  async getWebhookEvent(provider: string, externalEventId: string): Promise<WebhookEventRecord | null> {
    const [row] = await this.db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.externalEventId, externalEventId)))
      .limit(1);
    return row ? toWebhookEvent(row) : null;
  }

  async createWebhookEvent(event: NormalizedWebhookEvent): Promise<WebhookEventRecord> {
    const [row] = await this.db
      .insert(webhookEvents)
      .values({
        id: crypto.randomUUID(),
        provider: event.provider,
        externalEventId: event.externalEventId,
        eventType: event.eventType,
        signatureValid: event.signatureValid ? "true" : "false",
        status: "received",
        payloadJson: event.payloadJson,
        receivedAt: new Date(),
      })
      .returning();
    return toWebhookEvent(row);
  }

  async markWebhookEventProcessed(id: string, status: "processed" | "failed") {
    const [row] = await this.db
      .update(webhookEvents)
      .set({
        status,
        processedAt: new Date(),
      })
      .where(eq(webhookEvents.id, id))
      .returning();
    return toWebhookEvent(row);
  }

  private async getConversationByIdOrThrow(conversationId: string) {
    const conversation = await this.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    return conversation;
  }

  private async listReadyAttachmentsByMessageIds(messageIds: string[]) {
    if (messageIds.length === 0) {
      return new Map<string, ChatMessageAttachment[]>();
    }

    const rows = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          inArray(attachments.messageId, messageIds),
          eq(attachments.status, "ready"),
          isNull(attachments.deletedAt)
        )
      )
      .orderBy(asc(attachments.createdAt), asc(attachments.id));

    const map = new Map<string, ChatMessageAttachment[]>();
    for (const row of rows) {
      if (!row.messageId) {
        continue;
      }
      const bucket = map.get(row.messageId) ?? [];
      bucket.push(toChatMessageAttachment(row));
      map.set(row.messageId, bucket);
    }
    return map;
  }
}

function toChatUser(row: typeof users.$inferSelect): ChatUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toChatMessage(row: typeof messages.$inferSelect, messageAttachments: ChatMessageAttachment[]): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId,
    body: row.body,
    editedAt: row.editedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    attachments: messageAttachments,
  };
}

function toChatMessageAttachment(row: typeof attachments.$inferSelect): ChatMessageAttachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    status: row.status,
    publicUrl: buildAttachmentPublicUrl(row.storageBucket, row.storageKey),
  };
}

function buildAttachmentPublicUrl(bucket: string, key: string) {
  const configuredBase = Bun.env.ATTACHMENT_PUBLIC_BASE_URL?.trim();
  const base = configuredBase || `https://storage.googleapis.com/${bucket}`;
  return `${base.replace(/\/+$/g, "")}/${key}`;
}

function toChatAttachment(row: typeof attachments.$inferSelect): ChatAttachment {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId ?? null,
    uploadedByUserId: row.uploadedByUserId,
    storageBucket: row.storageBucket,
    storageKey: row.storageKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    filename: row.filename,
    status: row.status,
    publicUrl: "",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWebhookEvent(row: typeof webhookEvents.$inferSelect): WebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    signatureValid: row.signatureValid === "true",
    status: row.status,
    payloadJson: row.payloadJson,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}
