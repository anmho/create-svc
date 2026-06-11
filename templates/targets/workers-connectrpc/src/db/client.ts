import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

export function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

// Long-lived pooled handle for scripts and tests running under Bun.
export function createDb(databaseUrl = requireDatabaseUrl()): NodePgDatabase {
  return drizzle({ client: new Pool({ connectionString: databaseUrl }) });
}

export type RequestDb = {
  db: NodePgDatabase;
  close(): Promise<void>;
};

// Workers cannot reuse TCP connections across requests reliably, so each
// request opens one connection (cheap through Hyperdrive's edge pool) and
// closes it after the response via executionCtx.waitUntil.
export async function connectRequestDb(connectionString: string): Promise<RequestDb> {
  const client = new Client({ connectionString });
  await client.connect();
  return {
    db: drizzle({ client }),
    close: async () => {
      await client.end().catch(() => undefined);
    },
  };
}
