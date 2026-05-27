import { SQL } from "bun";
import { readLocalEnv } from "./local-env";

const env = {
  ...Bun.env,
  ...(await readLocalEnv()),
};
const databaseUrl = env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const client = new SQL(databaseUrl);
const deadline = Date.now() + 45_000;
let lastError: unknown;

while (Date.now() < deadline) {
  try {
    await client.unsafe("select 1");
    process.exit(0);
  } catch (error) {
    lastError = error;
    await Bun.sleep(1_000);
  }
}

throw new Error(`Timed out waiting for Postgres: ${formatError(lastError)}`);

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
