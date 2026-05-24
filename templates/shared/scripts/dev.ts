import { readLocalEnv } from "./local-env";
import { ensureLocalPostgres } from "./local-docker";

const { apiCommand, workerCommand } = parseCommands(Bun.argv.slice(2));

if (apiCommand.length === 0) {
  throw new Error("Usage: bun run ./scripts/dev.ts <api-command...> [--worker <worker-command...>]");
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

const api = Bun.spawn(apiCommand, {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env,
});

const worker = workerCommand
  ? Bun.spawn(workerCommand, {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...env,
        PORT: env.TEMPORAL_WORKER_PORT || "0",
      },
    })
  : undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    api.kill(signal);
    worker?.kill(signal);
  });
}

const exitCode = await Promise.race([api.exited, worker?.exited ?? new Promise<never>(() => {})]);
api.kill();
worker?.kill();
process.exit(exitCode);

function parseCommands(argv: string[]) {
  const separator = argv.indexOf("--worker");
  if (separator === -1) {
    return { apiCommand: argv, workerCommand: undefined };
  }
  const apiCommand = argv.slice(0, separator);
  const workerCommand = argv.slice(separator + 1);
  return { apiCommand, workerCommand: workerCommand.length > 0 ? workerCommand : undefined };
}
