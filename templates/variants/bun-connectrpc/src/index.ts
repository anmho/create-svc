import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { createServer } from "node:http2";
import { DNSService, RecordSchema, type Record as DnsRecord } from "../gen/protos/dns/v1/dns_pb.js";

type DnsService = ServiceImpl<typeof DNSService>;
type FallbackHandler = NonNullable<Parameters<typeof connectNodeAdapter>[0]["fallback"]>;

export function createDnsService(): Partial<DnsService> {
  const records: DnsRecord[] = [];
  let nextId = 1;

  return {
    listRecords() {
      return { records };
    },
    createRecord(request) {
      const record: DnsRecord = create(RecordSchema, {
        id: `record-${nextId++}`,
        type: request.type,
        name: request.name,
        content: request.content,
        ttl: request.ttl,
        proxied: request.proxied,
      });
      records.push(record);
      return { record };
    },
    updateRecord(request) {
      const record = records.find((candidate) => candidate.id === request.id);
      if (!record) {
        throw new ConnectError(`record ${request.id} not found`, Code.NotFound);
      }
      record.type = request.type;
      record.name = request.name;
      record.content = request.content;
      record.ttl = request.ttl;
      record.proxied = request.proxied;
      return { record };
    },
    deleteRecord(request) {
      const index = records.findIndex((candidate) => candidate.id === request.id);
      if (index === -1) {
        throw new ConnectError(`record ${request.id} not found`, Code.NotFound);
      }
      records.splice(index, 1);
      return {};
    },
  };
}

export function createHandler() {
  return connectNodeAdapter({
    routes: (router) => {
      router.service(DNSService, createDnsService());
    },
    fallback: ((request: Parameters<FallbackHandler>[0], response: Parameters<FallbackHandler>[1]) => {
      const path = request.url ?? "/";

      if (path === "/healthz") {
        respondJson(response, 200, {
          status: "ok",
          runtime: "bun",
          framework: "connectrpc",
        });
        return;
      }

      if (path === "/") {
        respondJson(response, 200, {
          service: "{{SERVICE_NAME}}",
          apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
        });
        return;
      }

      respondJson(response, 404, { error: "not found" });
    }) as FallbackHandler,
  });
}

function respondJson(response: Parameters<FallbackHandler>[1], status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

if (import.meta.main) {
  const port = Number(Bun.env.PORT ?? 8080);
  const server = createServer(createHandler());
  server.listen(port);
}
