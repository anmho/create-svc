import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { run as runScaffoldCli } from "./cli";

const SCAFFOLD_COMMANDS = new Set(["create", "new", "init"]);

export async function runServiceCommand(argv: string[], cwd = process.cwd()) {
  const serviceRoot = findGeneratedServiceRoot(cwd);
  if (serviceRoot) {
    delegateToGeneratedService(serviceRoot, argv);
    return;
  }

  await runScaffoldCli(normalizeScaffoldArgs(argv));
}

export function normalizeScaffoldArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (command && SCAFFOLD_COMMANDS.has(command)) {
    return rest;
  }
  if (command === "help") {
    return ["--help", ...rest];
  }
  return argv;
}

export function findGeneratedServiceRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    if (isGeneratedServiceRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isGeneratedServiceRoot(path: string) {
  return (
    existsSync(join(path, "service.config.ts")) &&
    (existsSync(join(path, "scripts", "cloudrun", "cli.ts")) || existsSync(join(path, "scripts", "workers", "cli.ts")))
  );
}

function delegateToGeneratedService(serviceRoot: string, argv: string[]) {
  ensureGeneratedDependencies(serviceRoot);

  const cliPath = existsSync(join(serviceRoot, "scripts", "cloudrun", "cli.ts"))
    ? "./scripts/cloudrun/cli.ts"
    : "./scripts/workers/cli.ts";
  const result = Bun.spawnSync(["bun", "run", cliPath, ...argv], {
    cwd: serviceRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  if (!result.success) {
    process.exit(result.exitCode || 1);
  }
}

export function generatedDependenciesInstalled(serviceRoot: string) {
  return !existsSync(join(serviceRoot, "package.json")) || existsSync(join(serviceRoot, "node_modules"));
}

function ensureGeneratedDependencies(serviceRoot: string) {
  if (generatedDependenciesInstalled(serviceRoot)) {
    return;
  }

  const result = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: serviceRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!result.success) {
    const output = [result.stdout.toString().trim(), result.stderr.toString().trim()].filter(Boolean).join("\n");
    console.error(["Failed to install generated service dependencies with bun install --silent", output].filter(Boolean).join("\n"));
    process.exit(result.exitCode || 1);
  }
}
