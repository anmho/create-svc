import { Hono } from "hono";
import { authMiddleware } from "./auth";
import { resolveCloudRunEnv } from "./env";
import { AppError, createDefaultWaitlistService, type WaitlistService } from "./waitlist/service";
import { assertTemporalRuntimeConfig } from "./temporal";

export function createApp(service: WaitlistService) {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ok" }));
  app.get("/", (context) =>
    context.json({
      service: "{{SERVICE_NAME}}",
      domain: "waitlist",
      apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
    })
  );

  app.use("/v1/*", authMiddleware());

  app.post("/v1/waitlist", async (context) => {
    try {
      const body = await context.req.json();
      const result = await service.joinWaitlist({
        email: String(body.email ?? ""),
        name: body.name ?? null,
        company: body.company ?? null,
        source: body.source ?? null,
      });
      return context.json(result, result.created ? 201 : 200);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/waitlist", async (context) => {
    try {
      return context.json({ entry: await service.getWaitlistEntryByEmail(context.req.query("email") ?? "") });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/waitlist/:entryId", async (context) => {
    try {
      return context.json({ entry: await service.getWaitlistEntry(context.req.param("entryId")) });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/admin/waitlist", async (context) => {
    try {
      return context.json({
        entries: await service.listWaitlistEntries({
          status: context.req.query("status"),
          limit: parseOptionalNumber(context.req.query("limit")),
        }),
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.patch("/v1/admin/waitlist/:entryId", async (context) => {
    try {
      const body = await context.req.json();
      return context.json({
        entry: await service.updateWaitlistEntry({
          entryId: context.req.param("entryId"),
          status: String(body.status ?? ""),
        }),
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/admin/waitlist/export", async (context) => {
    try {
      const csv = await service.exportWaitlistEntries({
        status: context.req.query("status"),
        limit: parseOptionalNumber(context.req.query("limit")),
      });
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="waitlist.csv"',
        },
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/v1/triggers/waitlist", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({}));
      const trigger = await service.recordTrigger({
        type: String(body.type ?? "manual"),
        entryId: body.entry_id ?? body.entryId ?? null,
        payload: body,
      });
      return context.json({ trigger }, 202);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/webhooks/:provider", async (context) => {
    try {
      const rawBody = await context.req.text();
      const provider = context.req.param("provider");
      const headers = Object.fromEntries(context.req.raw.headers);
      const payload = parseWebhookPayload(rawBody);
      const result = await service.recordWebhookEvent({
        provider,
        externalEventId: webhookEventId(payload, context.req.raw.headers),
        payload,
        headers,
      });
      if (!result.duplicate) {
        await service.recordTrigger({
          type: `webhook.${provider}`,
          entryId: null,
          payload: {
            headers,
            rawBody,
          },
        });
      }
      return context.json(result, result.duplicate ? 200 : 202);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/webhooks/:provider/health", (context) => context.json({ status: "ok", provider: context.req.param("provider") }));

  return app;
}

function writeError(context: any, error: unknown) {
  if (error instanceof AppError) {
    return context.json({ error: error.message, code: error.code }, error.status);
  }

  console.error(error);
  return context.json({ error: "internal server error", code: "internal" }, 500);
}

function parseOptionalNumber(value: string | undefined) {
  return value ? Number(value) : null;
}

function parseWebhookPayload(rawBody: string) {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { rawBody };
  }
}

function webhookEventId(payload: unknown, headers: Headers) {
  if (payload && typeof payload === "object" && "id" in payload && typeof payload.id === "string") {
    return payload.id;
  }
  return headers.get("x-webhook-event-id") ?? crypto.randomUUID();
}

if (import.meta.main) {
  const env = resolveCloudRunEnv();
  assertTemporalRuntimeConfig();
  Bun.serve({
    port: env.PORT,
    fetch: createApp(createDefaultWaitlistService()).fetch,
  });
}
