import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatScaffoldHelp, run as runScaffoldCli } from "./cli";
import { parseJsonc } from "./jsonc";

const SCAFFOLD_COMMANDS = new Set(["create", "new", "init"]);
const GENERATED_SERVICE_COMMANDS = new Set([
  "auth",
  "create",
  "dashboards",
  "deploy",
  "destroy",
  "dev",
  "dns",
  "doctor",
  "migrate",
  "sdk",
  "seed",
]);

export async function runServiceCommand(argv: string[], cwd = process.cwd()) {
  if (isVersionCommand(argv)) {
    console.log(createSvcVersion());
    return;
  }

  const serviceRoot = findGeneratedServiceRoot(cwd);
  if (serviceRoot) {
    await delegateToGeneratedService(serviceRoot, argv);
    return;
  }

  const [command] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(formatScaffoldHelp());
    return;
  }

  if (SCAFFOLD_COMMANDS.has(command)) {
    await runScaffoldCli(normalizeScaffoldArgs(argv));
    return;
  }

  console.error(formatOutsideServiceCommandError(command));
  process.exit(1);
}

function isVersionCommand(argv: string[]) {
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version");
}

export function createSvcVersion() {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return packageJson.version || "unknown";
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

export function formatOutsideServiceCommandError(command: string) {
  if (GENERATED_SERVICE_COMMANDS.has(command)) {
    return [
      `service ${command} must be run inside a generated service repo.`,
      "",
      "No service.jsonc was found in this directory or its parents.",
      "To create a new service, run:",
      "  service new <service_id>",
    ].join("\n");
  }

  return [`Unknown command: ${command}`, "", formatScaffoldHelp()].join("\n");
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
  return existsSync(join(path, "service.jsonc"));
}

async function delegateToGeneratedService(serviceRoot: string, argv: string[]) {
  const commandHelp = generatedServiceCommandHelp(argv);
  if (commandHelp) {
    console.log(commandHelp);
    return;
  }

  ensureGeneratedDependencies(serviceRoot);
  process.chdir(serviceRoot);
  process.env.CREATE_SVC_SERVICE_ROOT = serviceRoot;

  const serviceConfig = parseJsonc(await Bun.file(join(serviceRoot, "service.jsonc")).text()) as { target?: string };
  if (serviceConfig.target === "workers") {
    const { main } = await import("./service-runtime/workers/cli");
    await main(argv);
    return;
  }

  const { main } = await import("./service-runtime/cloudrun/cli");
  await main(argv);
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

export function generatedServiceCommandHelp(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== "deploy" || !hasHelpFlag(rest)) {
    return undefined;
  }

  return [
    "Usage:",
    "  service deploy [--ci] [--environment main|preview|personal] [--name <name>]",
    "",
    "Options:",
    "  --ci                         Run without interactive prompts",
    "  --environment <environment>  Deploy main, preview, or personal",
    "  --name <name>                Name preview or personal environment",
    "  --build <local|cloudbuild>   Select image build strategy",
    "  --cloud-build                Use Cloud Build",
    "  --destroy                    Destroy a non-main deployment environment",
  ].join("\n");
}

function hasHelpFlag(args: string[]) {
  return args.includes("--help") || args.includes("-h") || args.includes("help");
}
