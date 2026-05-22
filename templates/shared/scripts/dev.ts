import { readLocalEnv } from "./local-env";
import { ensureLocalPostgres } from "./local-docker";

const command = Bun.argv.slice(2);

if (command.length === 0) {
  throw new Error("Usage: bun run ./scripts/dev.ts <command...>");
}

await ensureLocalPostgres();

const child = Bun.spawn(command, {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...Bun.env,
    ...(await readLocalEnv()),
  },
});

process.exit(await child.exited);
