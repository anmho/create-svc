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
if (temporalEnabled(env)) {
  await waitForTemporal(env.TEMPORAL_ADDRESS || "localhost:7233");
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

function temporalEnabled(env: Record<string, string | undefined>) {
  return (env.TEMPORAL_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

async function waitForTemporal(address: string) {
  const { host, port } = parseTemporalAddress(address);
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const exitCode = await Bun.spawn(["nc", "-z", host, String(port)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    if (exitCode === 0) {
      return;
    }
    await Bun.sleep(2_000);
  }

  throw new Error(`Temporal did not become ready at ${host}:${port} within 120 seconds`);
}

function parseTemporalAddress(address: string) {
  const trimmed = address.trim();
  const withoutScheme = trimmed.includes("://") ? new URL(trimmed).host : trimmed;
  const [host = "localhost", port = "7233"] = withoutScheme.split(":");
  return {
    host: host || "localhost",
    port: Number(port || "7233"),
  };
}
