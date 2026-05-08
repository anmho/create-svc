import type {
  AttachmentObjectMetadata,
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  ChatUser,
  CreateAttachmentUploadInput,
  CreateAttachmentUploadResult,
  CreateConversationInput,
  ListMessagesInput,
  ListMessagesResult,
  CreateMessageInput,
  CreateUserInput,
  FinalizeAttachmentInput,
  UpdateConversationInput,
  UpdateMessageInput,
  WebhookProcessResult,
} from "./types";
import { createDb } from "../db/client";
import { ChatRepository } from "../db/repository";
import { createAttachmentStorage, type AttachmentStorage } from "../storage";
import { createWebhookAdapter, type WebhookAdapter } from "../webhooks";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type ChatService = {
  createUser(input: CreateUserInput): Promise<ChatUser>;
  getUser(userId: string): Promise<ChatUser>;
  getUserByUsername(username: string): Promise<ChatUser>;
  createConversation(input: CreateConversationInput): Promise<ChatConversation>;
  getConversation(conversationId: string): Promise<ChatConversation>;
  updateConversation(conversationId: string, input: UpdateConversationInput): Promise<ChatConversation>;
  deleteConversation(conversationId: string): Promise<void>;
  addParticipant(conversationId: string, userId: string): Promise<ChatConversation>;
  removeParticipant(conversationId: string, userId: string): Promise<void>;
  listMessages(conversationId: string, input?: ListMessagesInput): Promise<ListMessagesResult>;
  createMessage(conversationId: string, input: CreateMessageInput): Promise<ChatMessage>;
  updateMessage(conversationId: string, messageId: string, input: UpdateMessageInput): Promise<ChatMessage>;
  deleteMessage(conversationId: string, messageId: string): Promise<void>;
  createAttachmentUpload(input: CreateAttachmentUploadInput): Promise<CreateAttachmentUploadResult>;
  finalizeAttachment(attachmentId: string, input: FinalizeAttachmentInput): Promise<ChatAttachment>;
  getAttachment(attachmentId: string): Promise<ChatAttachment>;
  deleteAttachment(attachmentId: string): Promise<void>;
  processWebhook(provider: string, headers: Headers, rawBody: string): Promise<WebhookProcessResult>;
};

export class DefaultChatService implements ChatService {
  constructor(
    private readonly repository: ChatRepository,
    private readonly storage: AttachmentStorage,
    private readonly webhookAdapter: WebhookAdapter
  ) {}

  async createUser(input: CreateUserInput) {
    const username = input.username.trim().toLowerCase();
    if (!username) {
      throw new AppError(400, "invalid_username", "username is required");
    }

    const existing = await this.repository.getUserByUsername(username);
    if (existing) {
      throw new AppError(409, "username_taken", `username ${username} already exists`);
    }

    return this.repository.createUser({
      id: crypto.randomUUID(),
      username,
      displayName: normalizeNullableText(input.displayName),
    });
  }

  async getUser(userId: string) {
    return this.requireUser(userId);
  }

  async getUserByUsername(username: string) {
    const normalized = username.trim().toLowerCase();
    if (!normalized) {
      throw new AppError(400, "invalid_username", "username is required");
    }

    const user = await this.repository.getUserByUsername(normalized);
    if (!user) {
      throw new AppError(404, "user_not_found", `user ${normalized} not found`);
    }
    return user;
  }

  async createConversation(input: CreateConversationInput) {
    const createdBy = await this.requireUser(input.createdByUserId);
    const participantUserIds = new Set([createdBy.id, ...(input.participantUserIds ?? []).map((value) => value.trim()).filter(Boolean)]);
    await this.requireUsers(Array.from(participantUserIds));

    return this.repository.createConversation({
      id: crypto.randomUUID(),
      createdByUserId: createdBy.id,
      title: normalizeNullableText(input.title),
      participantUserIds: Array.from(participantUserIds),
    });
  }

  async getConversation(conversationId: string) {
    return this.requireConversation(conversationId);
  }

  async updateConversation(conversationId: string, input: UpdateConversationInput) {
    await this.requireConversation(conversationId);
    return this.repository.updateConversation(conversationId, normalizeNullableText(input.title));
  }

  async deleteConversation(conversationId: string) {
    await this.requireConversation(conversationId);
    await this.repository.softDeleteConversation(conversationId);
  }

  async addParticipant(conversationId: string, userId: string) {
    await this.requireConversation(conversationId);
    const user = await this.requireUser(userId);
    await this.repository.addParticipant(conversationId, user.id);
    return this.requireConversation(conversationId);
  }

  async removeParticipant(conversationId: string, userId: string) {
    const conversation = await this.requireConversation(conversationId);
    const isParticipant = conversation.participants.some((participant) => participant.id === userId);
    if (!isParticipant) {
      throw new AppError(404, "participant_not_found", `user ${userId} is not a participant`);
    }
    await this.repository.removeParticipant(conversationId, userId);
  }

  async listMessages(conversationId: string, input: ListMessagesInput = {}) {
    await this.requireConversation(conversationId);
    const limit = normalizeMessagePageSize(input.limit);
    const cursor = parseMessageCursor(input.cursor);
    const result = await this.repository.listMessages(conversationId, { limit, cursor });
    return {
      messages: result.messages,
      nextCursor: result.hasMore ? encodeMessageCursor(result.messages[result.messages.length - 1]!) : undefined,
    };
  }

  async createMessage(conversationId: string, input: CreateMessageInput) {
    const conversation = await this.requireConversation(conversationId);
    const user = await this.requireUser(input.userId);
    if (!conversation.participants.some((participant) => participant.id === user.id)) {
      throw new AppError(409, "not_a_participant", `user ${user.id} is not a participant`);
    }

    const body = input.body.trim();
    if (!body) {
      throw new AppError(400, "invalid_body", "message body is required");
    }

    return this.repository.createMessage({
      id: crypto.randomUUID(),
      conversationId,
      userId: user.id,
      body,
    });
  }

  async updateMessage(conversationId: string, messageId: string, input: UpdateMessageInput) {
    await this.requireConversation(conversationId);
    const existing = await this.repository.getMessageById(messageId);
    if (!existing || existing.conversationId !== conversationId) {
      throw new AppError(404, "message_not_found", `message ${messageId} not found`);
    }

    const body = input.body.trim();
    if (!body) {
      throw new AppError(400, "invalid_body", "message body is required");
    }

    return this.repository.updateMessage(messageId, body);
  }

  async deleteMessage(conversationId: string, messageId: string) {
    await this.requireConversation(conversationId);
    const existing = await this.repository.getMessageById(messageId);
    if (!existing || existing.conversationId !== conversationId) {
      throw new AppError(404, "message_not_found", `message ${messageId} not found`);
    }
    await this.repository.softDeleteMessage(messageId);
  }

  async createAttachmentUpload(input: CreateAttachmentUploadInput) {
    if (!input.contentType.startsWith("image/")) {
      throw new AppError(400, "invalid_content_type", "only image uploads are supported");
    }
    await this.requireConversation(input.conversationId);
    const user = await this.requireUser(input.uploadedByUserId);
    if (input.byteSize <= 0) {
      throw new AppError(400, "invalid_byte_size", "byte_size must be positive");
    }

    const attachmentId = crypto.randomUUID();
    const uploadTarget = await this.storage.createSignedUpload({
      attachmentId,
      conversationId: input.conversationId,
      filename: input.filename,
      contentType: input.contentType,
    });

    const attachment = await this.repository.createAttachment({
      id: attachmentId,
      conversationId: input.conversationId,
      uploadedByUserId: user.id,
      storageBucket: uploadTarget.bucket,
      storageKey: uploadTarget.key,
      contentType: input.contentType,
      byteSize: input.byteSize,
      filename: input.filename,
    });

    return {
      attachment: { ...attachment, publicUrl: uploadTarget.publicUrl },
      upload: uploadTarget.upload,
    };
  }

  async finalizeAttachment(attachmentId: string, input: FinalizeAttachmentInput) {
    const attachment = await this.requireAttachment(attachmentId);
    let messageId: string | null = null;
    if (input.messageId) {
      const message = await this.repository.getMessageById(input.messageId);
      if (!message || message.conversationId !== attachment.conversationId) {
        throw new AppError(404, "message_not_found", `message ${input.messageId} not found`);
      }
      messageId = message.id;
    }

    const metadata = await this.storage.getObjectMetadata({
      bucket: attachment.storageBucket,
      key: attachment.storageKey,
    });
    this.validateAttachmentMetadata(attachment, metadata);

    const finalized = await this.repository.finalizeAttachment(attachmentId, {
      messageId,
      contentType: metadata.contentType,
      byteSize: metadata.byteSize,
    });
    return { ...finalized, publicUrl: metadata.publicUrl };
  }

  async getAttachment(attachmentId: string) {
    return this.requireAttachment(attachmentId);
  }

  async deleteAttachment(attachmentId: string) {
    await this.requireAttachment(attachmentId);
    await this.repository.softDeleteAttachment(attachmentId);
  }

  async processWebhook(provider: string, headers: Headers, rawBody: string): Promise<WebhookProcessResult> {
    const event = await this.webhookAdapter.normalize(provider, headers, rawBody);
    const existing = await this.repository.getWebhookEvent(event.provider, event.externalEventId);
    if (existing) {
      return { event: existing, duplicate: true };
    }

    const created = await this.repository.createWebhookEvent(event);
    const status = event.signatureValid ? "processed" : "failed";
    const updated = await this.repository.markWebhookEventProcessed(created.id, status);
    return { event: updated, duplicate: false };
  }

  private async requireUser(userId: string) {
    const user = await this.repository.getUserById(userId);
    if (!user) {
      throw new AppError(404, "user_not_found", `user ${userId} not found`);
    }
    return user;
  }

  private async requireUsers(userIds: string[]) {
    const users = await this.repository.listUsersByIds(userIds);
    if (users.length !== userIds.length) {
      throw new AppError(404, "user_not_found", "one or more users do not exist");
    }
    return users;
  }

  private async requireConversation(conversationId: string) {
    const conversation = await this.repository.getConversationById(conversationId);
    if (!conversation) {
      throw new AppError(404, "conversation_not_found", `conversation ${conversationId} not found`);
    }
    return conversation;
  }

  private async requireAttachment(attachmentId: string) {
    const attachment = await this.repository.getAttachmentById(attachmentId);
    if (!attachment) {
      throw new AppError(404, "attachment_not_found", `attachment ${attachmentId} not found`);
    }
    const metadata = await this.storage.getObjectMetadata({
      bucket: attachment.storageBucket,
      key: attachment.storageKey,
    }).catch(() => null);
    return {
      ...attachment,
      publicUrl: metadata?.publicUrl ?? attachment.publicUrl,
    };
  }

  private validateAttachmentMetadata(attachment: ChatAttachment, metadata: AttachmentObjectMetadata) {
    if (metadata.contentType !== attachment.contentType) {
      throw new AppError(409, "content_type_mismatch", "uploaded object content_type does not match pending attachment");
    }
    if (metadata.byteSize !== attachment.byteSize) {
      throw new AppError(409, "byte_size_mismatch", "uploaded object byte_size does not match pending attachment");
    }
  }
}

export function createDefaultChatService() {
  const db = createDb();
  return new DefaultChatService(new ChatRepository(db), createAttachmentStorage(), createWebhookAdapter());
}

function normalizeNullableText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 100;

function normalizeMessagePageSize(limit: number | null | undefined) {
  if (limit == null) {
    return DEFAULT_MESSAGE_PAGE_SIZE;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new AppError(400, "invalid_limit", "limit must be a positive integer");
  }
  if (limit > MAX_MESSAGE_PAGE_SIZE) {
    throw new AppError(400, "invalid_limit", `limit must be at most ${MAX_MESSAGE_PAGE_SIZE}`);
  }
  return limit;
}

type MessageCursor = {
  createdAt: string;
  id: string;
};

function parseMessageCursor(cursor: string | null | undefined): MessageCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<MessageCursor>;
    if (typeof value.createdAt !== "string" || typeof value.id !== "string" || !value.createdAt || !value.id) {
      throw new Error("invalid cursor payload");
    }
    return {
      createdAt: value.createdAt,
      id: value.id,
    };
  } catch {
    throw new AppError(400, "invalid_cursor", "cursor is invalid");
  }
}

function encodeMessageCursor(message: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: message.createdAt, id: message.id }), "utf8").toString("base64url");
}
