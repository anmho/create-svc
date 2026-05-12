import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { createServer } from "node:http2";
import { ChatService as ChatRpcService } from "@svc/api-client";
import { AppError, createDefaultChatService, type ChatService } from "./chat/service";

type RpcService = ServiceImpl<typeof ChatRpcService>;
type FallbackHandler = NonNullable<Parameters<typeof connectNodeAdapter>[0]["fallback"]>;

export function createRpcService(service: ChatService): Partial<RpcService> {
  return {
    async createUser(request) {
      const user = await service.createUser({
        username: request.username,
        displayName: request.displayName || null,
      });
      return { user: toRpcUser(user) };
    },
    async getUser(request) {
      return { user: toRpcUser(await service.getUser(request.userId)) };
    },
    async getUserByUsername(request) {
      return { user: toRpcUser(await service.getUserByUsername(request.username)) };
    },
    async createConversation(request) {
      return {
        conversation: toRpcConversation(
          await service.createConversation({
            createdByUserId: request.createdByUserId,
            title: request.title || null,
            participantUserIds: request.participantUserIds,
          })
        ),
      };
    },
    async getConversation(request) {
      return { conversation: toRpcConversation(await service.getConversation(request.conversationId)) };
    },
    async updateConversation(request) {
      return {
        conversation: toRpcConversation(
          await service.updateConversation(request.conversationId, { title: request.title || null })
        ),
      };
    },
    async deleteConversation(request) {
      await service.deleteConversation(request.conversationId);
      return {};
    },
    async addConversationParticipant(request) {
      return {
        conversation: toRpcConversation(
          await service.addParticipant(request.conversationId, request.userId)
        ),
      };
    },
    async removeConversationParticipant(request) {
      await service.removeParticipant(request.conversationId, request.userId);
      return {};
    },
    async listMessages(request) {
      const result = await service.listMessages(request.conversationId, {
        cursor: request.cursor || null,
        limit: request.limit || null,
      });
      return {
        messages: result.messages.map(toRpcMessage),
        nextCursor: result.nextCursor ?? "",
      };
    },
    async createMessage(request) {
      return {
        message: toRpcMessage(
          await service.createMessage(request.conversationId, {
            userId: request.userId,
            body: request.body,
          })
        ),
      };
    },
    async updateMessage(request) {
      return {
        message: toRpcMessage(
          await service.updateMessage(request.conversationId, request.messageId, { body: request.body })
        ),
      };
    },
    async deleteMessage(request) {
      await service.deleteMessage(request.conversationId, request.messageId);
      return {};
    },
    async createAttachmentUpload(request) {
      const result = await service.createAttachmentUpload({
        conversationId: request.conversationId,
        uploadedByUserId: request.userId,
        filename: request.filename,
        contentType: request.contentType,
        byteSize: Number(request.byteSize),
      });
      return {
        attachment: toRpcAttachment(result.attachment),
        upload: {
          method: result.upload.method,
          url: result.upload.url,
          headers: result.upload.headers,
        },
      };
    },
    async finalizeAttachment(request) {
      return {
        attachment: toRpcAttachment(
          await service.finalizeAttachment(request.attachmentId, { messageId: request.messageId || null })
        ),
      };
    },
    async getAttachment(request) {
      return { attachment: toRpcAttachment(await service.getAttachment(request.attachmentId)) };
    },
    async deleteAttachment(request) {
      await service.deleteAttachment(request.attachmentId);
      return {};
    },
  };
}

export function createHandler(service: ChatService) {
  return connectNodeAdapter({
    routes: (router) => {
      router.service(ChatRpcService, createRpcService(service));
    },
    fallback: (async (request: Parameters<FallbackHandler>[0], response: Parameters<FallbackHandler>[1]) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/healthz" || path === "/readyz") {
        respondJson(response, 200, { status: "ok" });
        return;
      }

      if (path === "/") {
        respondJson(response, 200, {
          service: "{{SERVICE_NAME}}",
          domain: "chat",
          apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
        });
        return;
      }

      if (path === "/debug/connectrpc" && isLocalRpcIntrospectionEnabled()) {
        respondJson(response, 200, createIntrospectionDocument());
        return;
      }

      if (request.method === "OPTIONS" && path.startsWith("/v1/")) {
        respondJson(response, 204, {});
        return;
      }

      if (path.startsWith("/v1/")) {
        try {
          if (request.method === "POST" && path === "/v1/users") {
            const body = await readJsonBody(request);
            const user = await service.createUser({
              username: stringValue(body.username),
              displayName: nullableStringValue(body.displayName),
            });
            respondJson(response, 200, { user: toRpcUser(user) });
            return;
          }

          if (request.method === "POST" && path === "/v1/conversations") {
            const body = await readJsonBody(request);
            const conversation = await service.createConversation({
              createdByUserId: stringValue(body.createdByUserId),
              title: nullableStringValue(body.title),
              participantUserIds: Array.isArray(body.participantUserIds)
                ? body.participantUserIds.map(stringValue)
                : [],
            });
            respondJson(response, 200, { conversation: toRpcConversation(conversation) });
            return;
          }

          const messagesMatch = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
          if (messagesMatch && request.method === "POST") {
            const conversationId = decodeURIComponent(messagesMatch[1] ?? "");
            const body = await readJsonBody(request);
            const message = await service.createMessage(conversationId, {
              userId: stringValue(body.userId),
              body: stringValue(body.body),
            });
            respondJson(response, 200, { message: toRpcMessage(message) });
            return;
          }

          if (messagesMatch && request.method === "GET") {
            const conversationId = decodeURIComponent(messagesMatch[1] ?? "");
            const result = await service.listMessages(conversationId, {
              cursor: url.searchParams.get("cursor"),
              limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null,
            });
            respondJson(response, 200, {
              messages: result.messages.map(toRpcMessage),
              nextCursor: result.nextCursor ?? "",
            });
            return;
          }
        } catch (error) {
          respondAppError(response, error);
          return;
        }
      }

      if (request.method === "POST" && path.startsWith("/webhooks/")) {
        try {
          const provider = path.split("/").filter(Boolean)[1] ?? "generic";
          const rawBody = await readRawBody(request);
          const result = await service.processWebhook(provider, toHeaders(request), rawBody);
          respondJson(response, result.duplicate ? 200 : 202, result);
        } catch (error) {
          respondAppError(response, error);
        }
        return;
      }

      if (request.method === "GET" && path.startsWith("/webhooks/") && path.endsWith("/health")) {
        const provider = path.split("/").filter(Boolean)[1] ?? "generic";
        respondJson(response, 200, { status: "ok", provider });
        return;
      }

      respondJson(response, 404, { error: "not found" });
    }) as FallbackHandler,
  });
}

export function createIntrospectionDocument() {
  return {
    service: ChatRpcService.typeName,
    file: ChatRpcService.file.proto.name,
    methods: ChatRpcService.methods.map((method) => ({
      name: method.name,
      localName: method.localName,
      kind: method.methodKind,
      input: method.input.typeName,
      output: method.output.typeName,
    })),
  };
}

export function isLocalRpcIntrospectionEnabled() {
  const override = Bun.env.ENABLE_RPC_INTROSPECTION?.trim().toLowerCase();
  if (override) {
    return !["0", "false", "no", "off"].includes(override);
  }
  return !Bun.env.K_SERVICE && Bun.env.NODE_ENV !== "production";
}

function toRpcUser(user: Awaited<ReturnType<ChatService["getUser"]>>) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? "",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toRpcConversation(conversation: Awaited<ReturnType<ChatService["getConversation"]>>) {
  return {
    id: conversation.id,
    title: conversation.title ?? "",
    createdByUserId: conversation.createdByUserId,
    participants: conversation.participants.map(toRpcUser),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function toRpcMessage(message: Awaited<ReturnType<ChatService["createMessage"]>>) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    userId: message.userId,
    body: message.body,
    editedAt: message.editedAt ?? "",
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteSize: BigInt(attachment.byteSize),
      status: attachment.status,
      publicUrl: attachment.publicUrl,
    })),
  };
}

function toRpcAttachment(attachment: Awaited<ReturnType<ChatService["getAttachment"]>>) {
  return {
    id: attachment.id,
    conversationId: attachment.conversationId,
    messageId: attachment.messageId ?? "",
    uploadedByUserId: attachment.uploadedByUserId,
    storageBucket: attachment.storageBucket,
    storageKey: attachment.storageKey,
    contentType: attachment.contentType,
    byteSize: BigInt(attachment.byteSize),
    filename: attachment.filename,
    status: attachment.status,
    publicUrl: attachment.publicUrl,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

function respondJson(response: Parameters<FallbackHandler>[1], status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.end(JSON.stringify(body));
}

function respondAppError(response: Parameters<FallbackHandler>[1], error: unknown) {
  if (error instanceof AppError) {
    respondJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof ConnectError) {
    respondJson(response, 500, { error: error.message, code: error.code });
    return;
  }
  respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
}

function readRawBody(request: Parameters<FallbackHandler>[0]) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonBody(request: Parameters<FallbackHandler>[0]) {
  const rawBody = await readRawBody(request);
  if (!rawBody) {
    return {} as Record<string, unknown>;
  }
  return JSON.parse(rawBody) as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function toHeaders(request: Parameters<FallbackHandler>[0]) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value) {
      headers.set(key, value);
    }
  }
  return headers;
}

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 8080);
  const server = createServer(createHandler(createDefaultChatService()));
  server.listen(port);
}
