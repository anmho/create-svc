import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

export function requireDatabaseUrl() {
  const databaseUrl = Bun.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

export function createDb(databaseUrl = requireDatabaseUrl()) {
  const client = new SQL(databaseUrl);
  return drizzle({ client });
}
