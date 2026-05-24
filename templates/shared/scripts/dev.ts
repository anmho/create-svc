import { readLocalEnv } from "./local-env";
import { ensureLocalPostgres } from "./local-docker";

const command = Bun.argv.slice(2);

if (command.length === 0) {
  throw new Error("Usage: bun run ./scripts/dev.ts <command...>");
}

await ensureLocalPostgres();
const localEnv = await readLocalEnv();
const env = {
  ...Bun.env,
  ...localEnv,
};
if (env.DATABASE_URL && !env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE) {
  env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = env.DATABASE_URL;
}

const child = Bun.spawn(command, {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env,
});

process.exit(await child.exited);
