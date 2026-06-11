import { Code, ConnectError, createConnectRouter } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { Hono } from "hono";
import { WaitlistService as WaitlistRpcService } from "@gen/protos/waitlist/v1/waitlist_pb";
import { authMiddleware } from "@/auth";
import { connectRequestDb, type RequestDb } from "@/db/client";
import { WaitlistRepository } from "@/db/repository";
import { createTriggerDevDispatcher, type TriggerDispatcher } from "@/trigger";
import { AppError, DefaultWaitlistService, type WaitlistService } from "@/waitlist/service";
import type { WaitlistEntry, WaitlistTrigger } from "@/waitlist/types";

export type Env = {
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  ENABLE_RPC_INTROSPECTION?: string;
  AUTH_ENABLED?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_JWKS_URL?: string;
  TRIGGER_SECRET_KEY?: string;
  TRIGGER_TASK_ID?: string;
  TRIGGER_API_URL?: string;
};

type RpcService = ServiceImpl<typeof WaitlistRpcService>;

export function createRpcService(service: WaitlistService): Partial<RpcService> {
  return {
    async joinWaitlist(request) {
      const result = await service.joinWaitlist({
        email: request.email,
        name: request.name || null,
        company: request.company || null,
        source: request.source || null,
      });
      return { entry: toRpcEntry(result.entry), created: result.created };
    },
    async getWaitlistEntry(request) {
      return { entry: toRpcEntry(await service.getWaitlistEntry(request.entryId)) };
    },
    async getWaitlistEntryByEmail(request) {
      return { entry: toRpcEntry(await service.getWaitlistEntryByEmail(request.email)) };
    },
    async listWaitlistEntries(request) {
      const entries = await service.listWaitlistEntries({
        status: request.status || null,
        limit: request.limit || null,
      });
      return { entries: entries.map(toRpcEntry) };
    },
    async updateWaitlistEntry(request) {
      return {
        entry: toRpcEntry(
          await service.updateWaitlistEntry({
            entryId: request.entryId,
            status: request.status,
          })
        ),
      };
    },
    async exportWaitlistEntries(request) {
      return {
        csv: await service.exportWaitlistEntries({
          status: request.status || null,
          limit: request.limit || null,
        }),
      };
    },
    async recordTrigger(request) {
      const trigger = (await service.recordTrigger({
        type: request.type,
        entryId: request.entryId || null,
        payloadJson: request.payloadJson || "{}",
      })) as WaitlistTrigger;
      return { trigger: toRpcTrigger(trigger) };
    },
  };
}

export function createRpcFetchHandlers(service: WaitlistService) {
  const router = createConnectRouter();
  router.service(WaitlistRpcService, createRpcService(service));
  return new Map(router.handlers.map((handler) => [handler.requestPath, createFetchHandler(handler)]));
}

export function createIntrospectionDocument() {
  return {
    service: WaitlistRpcService.typeName,
    file: WaitlistRpcService.file.proto.name,
    methods: WaitlistRpcService.methods.map((method) => ({
      name: method.name,
      localName: method.localName,
      kind: method.methodKind,
      input: method.input.typeName,
      output: method.output.typeName,
    })),
  };
}

export function isRpcIntrospectionEnabled(env: Env = {}) {
  const override = env.ENABLE_RPC_INTROSPECTION?.trim().toLowerCase();
  if (override) {
    return !["0", "false", "no", "off"].includes(override);
  }
  return false;
}

export type CreateAppOptions = {
  triggerDispatcher?: TriggerDispatcher;
  // Overridable for tests: build the per-request service without a database.
  serviceFactory?: (env: Env, executionCtx: ExecutionContext | undefined) => Promise<{ service: WaitlistService; cleanup?: () => Promise<void> }>;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const triggerDispatcher = options.triggerDispatcher ?? createTriggerDevDispatcher();

  const serviceFactory =
    options.serviceFactory ??
    (async (env: Env, _executionCtx: ExecutionContext | undefined) => {
      const connectionString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
      if (!connectionString) {
        throw new ConnectError("database is not configured", Code.Unavailable);
      }
      const request: RequestDb = await connectRequestDb(connectionString);
      const service = new DefaultWaitlistService(new WaitlistRepository(request.db), ({ trigger }) =>
        triggerDispatcher.dispatchWaitlistFollowUp(trigger, env)
      );
      return { service, cleanup: request.close };
    });

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ok" }));
  app.get("/metrics", () => new Response("# no custom metrics configured\n", { headers: { "content-type": "text/plain; charset=utf-8" } }));
  app.get("/", (context) =>
    context.json({
      service: "{{SERVICE_NAME}}",
      domain: "waitlist",
      apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
    })
  );
  app.get("/debug/connectrpc", (context) => {
    if (!isRpcIntrospectionEnabled(context.env)) {
      return context.json({ error: "not found" }, 404);
    }
    return context.json(createIntrospectionDocument());
  });

  app.use(`/${WaitlistRpcService.typeName}/*`, authMiddleware());

  app.post(`/${WaitlistRpcService.typeName}/:method`, async (context) => {
    const executionCtx = tryGetExecutionCtx(context);
    const { service, cleanup } = await serviceFactory(context.env, executionCtx);
    try {
      const handlers = createRpcFetchHandlers(service);
      const handler = handlers.get(new URL(context.req.url).pathname);
      if (!handler) {
        return context.json({ error: "not found" }, 404);
      }
      return await handler(context.req.raw);
    } finally {
      if (cleanup) {
        scheduleCleanup(executionCtx, cleanup);
      }
    }
  });

  app.post("/webhooks/:provider", async (context) => {
    const executionCtx = tryGetExecutionCtx(context);
    const { service, cleanup } = await serviceFactory(context.env, executionCtx);
    try {
      const provider = context.req.param("provider") || "generic";
      const rawBody = await context.req.text();
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
          payloadJson: JSON.stringify({ headers, rawBody }),
        });
      }
      return context.json(result, result.duplicate ? 200 : 202);
    } catch (error) {
      return writeError(context, error);
    } finally {
      if (cleanup) {
        scheduleCleanup(executionCtx, cleanup);
      }
    }
  });

  app.post("/internal/trigger/waitlist-follow-up", async (context) => {
    const executionCtx = tryGetExecutionCtx(context);
    const { service, cleanup } = await serviceFactory(context.env, executionCtx);
    try {
      const body = await context.req.json().catch(() => ({}));
      const trigger = await service.recordTrigger({
        type: "trigger.waitlist_follow_up",
        entryId: typeof body.entryId === "string" ? body.entryId : null,
        payloadJson: JSON.stringify(body),
      });
      return context.json({ status: "queued", trigger }, 202);
    } catch (error) {
      return writeError(context, error);
    } finally {
      if (cleanup) {
        scheduleCleanup(executionCtx, cleanup);
      }
    }
  });

  app.get("/webhooks/:provider/health", (context) => context.json({ status: "ok", provider: context.req.param("provider") || "generic" }));

  app.notFound((context) => context.json({ error: "not found" }, 404));

  return app;
}

// Hono's context.executionCtx getter throws outside a Workers runtime (e.g.
// bun test), so resolve it defensively once per request.
function tryGetExecutionCtx(context: { executionCtx: ExecutionContext }): ExecutionContext | undefined {
  try {
    return context.executionCtx;
  } catch {
    return undefined;
  }
}

function scheduleCleanup(executionCtx: ExecutionContext | undefined, cleanup: () => Promise<void>) {
  if (executionCtx) {
    executionCtx.waitUntil(cleanup());
    return;
  }
  // Outside a Workers runtime close inline instead of leaking the connection.
  void cleanup();
}

function writeError(context: { json: (body: unknown, status?: 200 | 202 | 400 | 404 | 409 | 500) => Response }, error: unknown) {
  if (error instanceof AppError) {
    const status = error.status === 400 || error.status === 404 || error.status === 409 ? error.status : 500;
    return context.json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof ConnectError) {
    return context.json({ error: error.message, code: Code[error.code] }, 500);
  }
  return context.json({ error: error instanceof Error ? error.message : String(error), code: "internal" }, 500);
}

function toRpcEntry(entry: WaitlistEntry) {
  return {
    id: entry.id,
    email: entry.email,
    name: entry.name ?? "",
    company: entry.company ?? "",
    source: entry.source ?? "",
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toRpcTrigger(trigger: WaitlistTrigger) {
  return {
    id: trigger.id,
    type: trigger.type,
    entryId: trigger.entryId ?? "",
    status: trigger.status,
    payloadJson: trigger.payloadJson,
    createdAt: trigger.createdAt,
    processedAt: trigger.processedAt ?? "",
  };
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

const app = createApp();

export default app;
