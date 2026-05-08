import { SQL } from "bun";

const databaseUrl = Bun.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const client = new SQL(databaseUrl);
await waitForDatabase(client);
const migrationId = "0000_init_chat";
const migrationSql = await Bun.file(new URL("../migrations/0000_init.sql", import.meta.url)).text();

await client.unsafe(`create table if not exists schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
)`);

const existing = await client`select id from schema_migrations where id = ${migrationId} limit 1`;
if (existing.length === 0) {
  await client.unsafe(migrationSql);
  await client`insert into schema_migrations (id) values (${migrationId})`;
  console.log(`Applied migration ${migrationId}`);
} else {
  console.log(`Migration ${migrationId} already applied`);
}

async function waitForDatabase(client: SQL, timeoutMs = 30_000) {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      await client.unsafe("select 1");
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1_000);
    }
  }

  throw new Error(`Timed out waiting for DATABASE_URL to accept connections: ${formatError(lastError)}`);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
