import { cancel, confirm, intro, isCancel, log, note, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldProject, type ScaffoldConfig } from "./scaffold";

type ParsedArgs = {
  directory?: string;
  modulePath?: string;
  projectId?: string;
  region?: string;
  githubRepo?: string;
  vaultAddr?: string;
  vaultSecretPath?: string;
  vaultSecretKey?: string;
  cloudflareZoneId?: string;
  bufModule?: string;
  yes: boolean;
  help: boolean;
};

const DEFAULT_REGION = "us-west1";
const DEFAULT_VAULT_ADDR = "https://vault.anmho.com";
const DEFAULT_VAULT_SECRET_PATH = "provider/cloudflare-api-token";
const DEFAULT_VAULT_SECRET_KEY = "value";
const DEFAULT_CLOUDFLARE_ZONE_ID = "893c2371cc222826de6e00583f4902ea";

export async function run(argv: string[]) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  intro(`${pc.bold("create-service")} ${pc.dim("Cloud Run scaffold")}`);

  const config = await resolveConfig(args);
  const targetDir = resolve(process.cwd(), config.directory);

  note(
    [
      `${pc.bold("Output")}: ${targetDir}`,
      `${pc.bold("Module")}: ${config.modulePath}`,
      `${pc.bold("Deploy")}: public Cloud Run service with Vault-backed Cloudflare DNS CRUD`,
    ].join("\n"),
    "Scaffold"
  );

  const buildSpinner = spinner();
  buildSpinner.start("Generating project files");
  await scaffoldProject(config);
  buildSpinner.stop("Project files generated");

  outro(
    [
      `Next: ${pc.cyan(`cd ${config.directory}`)}`,
      `Local dev: ${pc.cyan("bun dev")}`,
      `Generate stubs: ${pc.cyan("bun gen")}`,
      `First deploy: set ${pc.cyan("BOOTSTRAP_VAULT_ROLE_ID")} and ${pc.cyan("BOOTSTRAP_VAULT_SECRET_ID")}, then run ${pc.cyan("bun run deploy")}`,
    ].join("\n")
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    yes: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) {
      continue;
    }

    if (!token.startsWith("-") && !parsed.directory) {
      parsed.directory = token;
      continue;
    }

    const next = argv[i + 1];
    const readValue = () => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return next;
    };

    if (token === "--yes" || token === "-y") {
      parsed.yes = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }

    if (token === "--module") {
      parsed.modulePath = readValue();
      continue;
    }

    if (token.startsWith("--module=")) {
      parsed.modulePath = token.slice("--module=".length);
      continue;
    }

    if (token === "--project-id") {
      parsed.projectId = readValue();
      continue;
    }

    if (token.startsWith("--project-id=")) {
      parsed.projectId = token.slice("--project-id=".length);
      continue;
    }

    if (token === "--region") {
      parsed.region = readValue();
      continue;
    }

    if (token.startsWith("--region=")) {
      parsed.region = token.slice("--region=".length);
      continue;
    }

    if (token === "--github-repo") {
      parsed.githubRepo = readValue();
      continue;
    }

    if (token.startsWith("--github-repo=")) {
      parsed.githubRepo = token.slice("--github-repo=".length);
      continue;
    }

    if (token === "--vault-addr") {
      parsed.vaultAddr = readValue();
      continue;
    }

    if (token.startsWith("--vault-addr=")) {
      parsed.vaultAddr = token.slice("--vault-addr=".length);
      continue;
    }

    if (token === "--vault-secret-path") {
      parsed.vaultSecretPath = readValue();
      continue;
    }

    if (token.startsWith("--vault-secret-path=")) {
      parsed.vaultSecretPath = token.slice("--vault-secret-path=".length);
      continue;
    }

    if (token === "--vault-secret-key") {
      parsed.vaultSecretKey = readValue();
      continue;
    }

    if (token.startsWith("--vault-secret-key=")) {
      parsed.vaultSecretKey = token.slice("--vault-secret-key=".length);
      continue;
    }

    if (token === "--cloudflare-zone-id") {
      parsed.cloudflareZoneId = readValue();
      continue;
    }

    if (token.startsWith("--cloudflare-zone-id=")) {
      parsed.cloudflareZoneId = token.slice("--cloudflare-zone-id=".length);
      continue;
    }

    if (token === "--buf-module") {
      parsed.bufModule = readValue();
      continue;
    }

    if (token.startsWith("--buf-module=")) {
      parsed.bufModule = token.slice("--buf-module=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

async function resolveConfig(args: ParsedArgs): Promise<ScaffoldConfig> {
  const inferredName = slugify(basename(args.directory ?? "dns-api"));
  const serviceName = args.yes
    ? inferredName
    : await promptText("Service name", inferredName, (value) => slugify(value).length > 0 || "Service name is required");

  const directory = args.directory ?? serviceName;
  const githubRepo = args.githubRepo ?? `anmho/${serviceName}`;
  const modulePath = args.modulePath ?? `github.com/${githubRepo}`;
  const projectId = args.projectId ?? (args.yes ? "my-gcp-project" : "");
  const region = args.region ?? DEFAULT_REGION;
  const vaultAddr = args.vaultAddr ?? DEFAULT_VAULT_ADDR;
  const vaultSecretPath = args.vaultSecretPath ?? DEFAULT_VAULT_SECRET_PATH;
  const vaultSecretKey = args.vaultSecretKey ?? DEFAULT_VAULT_SECRET_KEY;
  const cloudflareZoneId = args.cloudflareZoneId ?? DEFAULT_CLOUDFLARE_ZONE_ID;
  const bufModule = args.bufModule ?? `buf.build/${githubRepo}`;

  const confirmedProjectId = projectId || (await promptText("GCP project ID", "my-gcp-project", (value) => value.trim().length > 0 || "Project ID is required"));
  const confirmedModulePath = args.yes
    ? modulePath
    : await promptText("Go module path", modulePath, (value) => value.trim().length > 0 || "Module path is required");
  const confirmedGithubRepo = args.yes
    ? githubRepo
    : await promptText("GitHub repo", githubRepo, (value) => value.includes("/") || "Use owner/repo format");
  const confirmedRegion = args.yes
    ? region
    : await promptText("Cloud Run region", region, (value) => value.trim().length > 0 || "Region is required");
  const confirmedBufModule = args.yes
    ? bufModule
    : await promptText("Buf module", bufModule, (value) => value.trim().length > 0 || "Buf module is required");

  if (!args.yes) {
    const okay = await confirm({
      message: "Create the scaffold with these defaults?",
      initialValue: true,
    });
    if (isCancel(okay) || !okay) {
      cancel("Aborted");
      process.exit(1);
    }
  }

  return {
    directory,
    serviceName,
    modulePath: confirmedModulePath,
    projectId: confirmedProjectId,
    region: confirmedRegion,
    githubRepo: confirmedGithubRepo,
    vaultAddr,
    vaultSecretPath,
    vaultSecretKey,
    cloudflareZoneId,
    bufModule: confirmedBufModule,
    generatorRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  };
}

async function promptText(
  message: string,
  initialValue: string,
  validate: (value: string) => true | string
): Promise<string> {
  const value = await text({
    message,
    initialValue,
    validate: (input) => normalizeValidationResult(validate(input.trim())),
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  return value.trim();
}

export function normalizeValidationResult(result: true | string): string | undefined {
  return result === true ? undefined : result;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function printHelp() {
  log.message(`
Usage:
  bun run index.ts [directory] [options]

Options:
  --module <path>               Go module path
  --project-id <id>             GCP project ID
  --region <region>             Cloud Run region
  --github-repo <owner/repo>    GitHub repository
  --vault-addr <url>            Vault address
  --vault-secret-path <path>    Vault KV secret path
  --vault-secret-key <key>      Vault KV secret key
  --cloudflare-zone-id <id>     Cloudflare zone ID
  --buf-module <module>         Buf module name
  --yes, -y                     Accept defaults without prompts
  --help, -h                    Show this message
`);
}
