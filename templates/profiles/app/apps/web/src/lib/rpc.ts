import { createHttpJsonChatClient } from "@svc/api-client";

export function createChatClient() {
  const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8080";
  return createHttpJsonChatClient({ baseUrl });
}
