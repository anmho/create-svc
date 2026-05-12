export type ChatUser = {
  id: string;
  username: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatConversation = {
  id: string;
  title: string | null;
  createdByUserId: string;
  participants: ChatUser[];
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  userId: string;
  body: string;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: ChatMessageAttachment[];
};

export type ChatMessageAttachment = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  status: "pending" | "ready" | "deleted";
  publicUrl: string;
};

export type ChatAttachment = {
  id: string;
  conversationId: string;
  messageId: string | null;
  uploadedByUserId: string;
  storageBucket: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  filename: string;
  status: "pending" | "ready" | "deleted";
  publicUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type WebhookEventRecord = {
  id: string;
  provider: string;
  externalEventId: string;
  eventType: string;
  signatureValid: boolean;
  status: "received" | "processed" | "failed";
  payloadJson: string;
  receivedAt: string;
  processedAt: string | null;
};

export type CreateUserInput = {
  username: string;
  displayName?: string | null;
};

export type CreateConversationInput = {
  createdByUserId: string;
  title?: string | null;
  participantUserIds?: string[];
};

export type UpdateConversationInput = {
  title?: string | null;
};

export type CreateMessageInput = {
  userId: string;
  body: string;
};

export type ListMessagesInput = {
  cursor?: string | null;
  limit?: number | null;
};

export type UpdateMessageInput = {
  body: string;
};

export type CreateAttachmentUploadInput = {
  conversationId: string;
  uploadedByUserId: string;
  filename: string;
  contentType: string;
  byteSize: number;
};

export type FinalizeAttachmentInput = {
  messageId?: string | null;
};

export type AttachmentUploadTarget = {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
};

export type CreateAttachmentUploadResult = {
  attachment: ChatAttachment;
  upload: AttachmentUploadTarget;
};

export type AttachmentObjectMetadata = {
  bucket: string;
  key: string;
  contentType: string;
  byteSize: number;
  publicUrl: string;
};

export type NormalizedWebhookEvent = {
  provider: string;
  externalEventId: string;
  eventType: string;
  signatureValid: boolean;
  payloadJson: string;
};

export type WebhookProcessResult = {
  event: WebhookEventRecord;
  duplicate: boolean;
};

export type ListMessagesResult = {
  messages: ChatMessage[];
  nextCursor?: string;
};
