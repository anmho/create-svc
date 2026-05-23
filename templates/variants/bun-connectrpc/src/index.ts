import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ServiceImpl } from "@connectrpc/connect";
import { createServer } from "node:http";
import { WaitlistService as WaitlistRpcService } from "../gen/protos/waitlist/v1/waitlist_pb.js";
import { withServiceAuth } from "./auth";
import { AppError, createDefaultWaitlistService, type WaitlistService } from "./waitlist/service";
import { startTemporalWorker } from "./temporal/worker";
import type { WaitlistEntry, WaitlistTrigger } from "./waitlist/types";

type RpcService = ServiceImpl<typeof WaitlistRpcService>;
type FallbackHandler = NonNullable<Parameters<typeof connectNodeAdapter>[0]["fallback"]>;

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

export function createHandler(service: WaitlistService) {
  return connectNodeAdapter({
    routes: (router) => {
      router.service(WaitlistRpcService, createRpcService(service));
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
          domain: "waitlist",
          apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
        });
        return;
      }

      if (path === "/debug/connectrpc" && isLocalRpcIntrospectionEnabled()) {
        respondJson(response, 200, createIntrospectionDocument());
        return;
      }

      if (request.method === "POST" && path.startsWith("/webhooks/")) {
        try {
          const provider = path.split("/").filter(Boolean)[1] ?? "generic";
          const rawBody = await readRawBody(request);
          const trigger = await service.recordTrigger({
            type: `webhook.${provider}`,
            payloadJson: JSON.stringify({ headers: request.headers, rawBody }),
          });
          respondJson(response, 202, { trigger });
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

export function isLocalRpcIntrospectionEnabled() {
  const override = Bun.env.ENABLE_RPC_INTROSPECTION?.trim().toLowerCase();
  if (override) {
    return !["0", "false", "no", "off"].includes(override);
  }
  return !Bun.env.K_SERVICE && Bun.env.NODE_ENV !== "production";
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

function respondJson(response: Parameters<FallbackHandler>[1], status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
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
  respondJson(response, 500, { error: error instanceof Error ? error.message : String(error), code: Code[Code.Internal] });
}

function readRawBody(request: Parameters<FallbackHandler>[0]) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

if (import.meta.main) {
  const temporalWorker = await startTemporalWorker();
  if (temporalWorker) {
    console.log(`Temporal worker polling ${temporalWorker.taskQueue}`);
  }

  const port = Number(Bun.env.PORT ?? 8080);
  const server = createServer(withServiceAuth(createHandler(createDefaultWaitlistService())));
  server.listen(port);
}
