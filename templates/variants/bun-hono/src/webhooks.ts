import type { NormalizedWebhookEvent } from "./chat/types";

export type WebhookAdapter = {
  normalize(provider: string, headers: Headers, rawBody: string): Promise<NormalizedWebhookEvent>;
};

export class GenericJsonWebhookAdapter implements WebhookAdapter {
  async normalize(provider: string, headers: Headers, rawBody: string): Promise<NormalizedWebhookEvent> {
    const payload = parseJson(rawBody);
    const secret = Bun.env[`WEBHOOK_${provider.toUpperCase()}_SECRET`]?.trim();
    const incomingSecret = headers.get("x-webhook-secret")?.trim() ?? "";
    const externalEventId = String(payload.id ?? headers.get("x-event-id") ?? crypto.randomUUID());
    const eventType = String(payload.type ?? headers.get("x-event-type") ?? "generic.event");

    return {
      provider,
      externalEventId,
      eventType,
      signatureValid: secret ? incomingSecret === secret : true,
      payloadJson: rawBody,
    };
  }
}

export function createWebhookAdapter() {
  return new GenericJsonWebhookAdapter();
}

function parseJson(rawBody: string) {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return {};
  }
}
