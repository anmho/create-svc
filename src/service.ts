import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatScaffoldHelp, run as runScaffoldCli } from "./cli";
import { parseProtectMainArgs, protectMainBranch } from "./github-protection";
import { parseJsonc } from "./jsonc";
import {
  buildServiceDoctorReport,
  findServiceBinaries,
  getInstalledServiceVersion,
  getNpmLatestVersion,
  packageRootFromModuleUrl,
} from "./service-diagnostics";

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
  "protect-main",
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

  if (command === "doctor") {
    runGlobalServiceDoctor();
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

function runGlobalServiceDoctor() {
  const latest = getNpmLatestVersion();
  const report = buildServiceDoctorReport({
    activeBinaryPath: process.argv[1] || "service",
    packageRoot: packageRootFromModuleUrl(import.meta.url),
    packageVersion: createSvcVersion(),
    latestVersion: latest.version,
    latestVersionError: latest.error,
    serviceBinaries: findServiceBinaries(),
    getBinaryVersion: getInstalledServiceVersion,
  });
  console.log(report.text);
  if (report.exitCode !== 0) {
    process.exit(report.exitCode);
  }
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

  const serviceConfig = parseJsonc(await Bun.file(join(serviceRoot, "service.jsonc")).text()) as {
    service_id?: string;
    target?: string;
    git?: {
      owner?: string;
      repository?: string;
    };
  };
  if (argv[0] === "protect-main") {
    const protectionArgs = parseProtectMainArgs(argv.slice(1));
    const result = protectMainBranch({
      repo: protectionArgs.repo ?? repoFromServiceConfig(serviceConfig),
      branch: protectionArgs.branch,
      cwd: serviceRoot,
    });
    console.log(`Verified ${result.repo} ${result.branch} branch protection with required checks: ${result.requiredChecks.join(", ")}`);
    return;
  }

  if (argv[0] === "sdk") {
    const { intro, outro } = await import("@clack/prompts");
    const { runConnectSdk } = await import("./service-commands/connect-sdk");
    intro("SDK");
    const result = await runConnectSdk(argv.slice(1));
    outro(result);
    return;
  }

  if (serviceConfig.target === "workers") {
    const { main } = await import("./service-commands/workers/cli");
    await main(argv);
    return;
  }

  const { main } = await import("./service-commands/cloudrun/cli");
  await main(argv);
}

function repoFromServiceConfig(serviceConfig: { service_id?: string; git?: { owner?: string; repository?: string } }) {
  const owner = serviceConfig.git?.owner || "anmho";
  const repository = serviceConfig.git?.repository || serviceConfig.service_id;
  if (!repository) {
    throw new Error("service.jsonc is missing git.repository and service_id; pass --repo owner/name.");
  }
  return `${owner}/${repository}`;
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
  if (command === "protect-main" && hasHelpFlag(rest)) {
    return [
      "Usage:",
      "  service protect-main [--repo owner/name] [--branch main]",
      "",
      "Applies and verifies generated service branch protection with required pull request checks.",
    ].join("\n");
  }

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
