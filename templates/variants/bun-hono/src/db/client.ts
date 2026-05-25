import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { resolveCloudRunEnv } from "../env";

export function requireDatabaseUrl() {
  return resolveCloudRunEnv().DATABASE_URL;
}

export function createDb(databaseUrl = requireDatabaseUrl()) {
  const client = new SQL(databaseUrl);
  return drizzle({ client });
}
