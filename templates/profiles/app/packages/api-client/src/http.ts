import { create, fromJson, toJson } from "@bufbuild/protobuf";
import type { DescMessage, JsonValue, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import {
  CreateConversationRequestSchema,
  CreateConversationResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateUserRequestSchema,
  CreateUserResponseSchema,
  ListMessagesResponseSchema,
  type CreateConversationResponse,
  type CreateMessageResponse,
  type CreateUserResponse,
  type ListMessagesResponse,
} from "./gen/chat/v1/chat_pb.js";

export type HttpJsonChatClient = {
  createUser(input: MessageInitShape<typeof CreateUserRequestSchema>): Promise<CreateUserResponse>;
  createConversation(input: MessageInitShape<typeof CreateConversationRequestSchema>): Promise<CreateConversationResponse>;
  createMessage(input: MessageInitShape<typeof CreateMessageRequestSchema>): Promise<CreateMessageResponse>;
  listMessages(input: { conversationId: string; cursor?: string; limit?: number }): Promise<ListMessagesResponse>;
};

export function createHttpJsonChatClient(options: { baseUrl: string; fetch?: typeof fetch }): HttpJsonChatClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  return {
    createUser(input) {
      return postJson(
        fetchImpl,
        `${baseUrl}/v1/users`,
        toJson(CreateUserRequestSchema, create(CreateUserRequestSchema, input)),
        CreateUserResponseSchema
      );
    },
    createConversation(input) {
      return postJson(
        fetchImpl,
        `${baseUrl}/v1/conversations`,
        toJson(CreateConversationRequestSchema, create(CreateConversationRequestSchema, input)),
        CreateConversationResponseSchema
      );
    },
    createMessage(input) {
      const conversationId = input.conversationId ?? "";
      return postJson(
        fetchImpl,
        `${baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        toJson(CreateMessageRequestSchema, create(CreateMessageRequestSchema, input)),
        CreateMessageResponseSchema
      );
    },
    listMessages(input) {
      const params = new URLSearchParams();
      if (input.cursor) {
        params.set("cursor", input.cursor);
      }
      if (input.limit) {
        params.set("limit", String(input.limit));
      }
      const query = params.size > 0 ? `?${params}` : "";
      return getJson(
        fetchImpl,
        `${baseUrl}/v1/conversations/${encodeURIComponent(input.conversationId)}/messages${query}`,
        ListMessagesResponseSchema
      );
    },
  };
}

async function postJson<Schema extends DescMessage>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  schema: Schema
): Promise<MessageShape<Schema>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonResponse(response, schema);
}

async function getJson<Schema extends DescMessage>(
  fetchImpl: typeof fetch,
  url: string,
  schema: Schema
): Promise<MessageShape<Schema>> {
  const response = await fetchImpl(url);
  return readJsonResponse(response, schema);
}

async function readJsonResponse<Schema extends DescMessage>(response: Response, schema: Schema): Promise<MessageShape<Schema>> {
  const json = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return fromJson(schema, json as JsonValue);
}
