import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  compactIdentifier,
  compactDatabaseName,
  deriveLocalPostgresPort,
  type DeployTarget,
  type Framework,
  type GcpProjectMode,
  type Runtime,
} from "./naming";
import { exampleForProfile, type Profile } from "./profiles";
import type { GitBootstrapConfig } from "./git-bootstrap";

export type ScaffoldConfig = {
  directory: string;
  serviceName: string;
  modulePath: string;
  target: DeployTarget;
  runtime: Runtime;
  framework: Framework;
  profile: Profile;
  region: string;
  gcpProjectMode: GcpProjectMode;
  gcpProject: string;
  gcpProjectName: string;
  billingAccount: string;
  quotaProjectId: string;
  autoDeploy: boolean;
  git: GitBootstrapConfig;
  neonDatabaseName: string;
  apiHostname: string;
  generatorRoot: string;
};

export class DirectoryConflictError extends Error {
  targetDir: string;
  entries: string[];

  constructor(targetDir: string, entries: string[]) {
    super(`Target directory already exists and is not empty: ${targetDir}`);
    this.name = "DirectoryConflictError";
    this.targetDir = targetDir;
    this.entries = entries;
  }
}

export async function scaffoldProject(config: ScaffoldConfig) {
  const targetDir = resolve(process.cwd(), config.directory);
  await ensureTargetDirectory(targetDir);

  const replacements = buildReplacements(config);
  const templateRoots = [
    { kind: "shared" as const, root: resolve(config.generatorRoot, "templates", "shared") },
    { kind: "variant" as const, root: resolve(config.generatorRoot, "templates", "variants", `${config.runtime}-${config.framework}`) },
    { kind: "target" as const, root: resolve(config.generatorRoot, "templates", "targets", config.target) },
  ];

  for (const template of templateRoots) {
    const files = await collectTemplateFiles(template.root);

    for (const relativePath of files) {
      if (shouldSkipForTarget(config.target, template.kind, relativePath)) {
        continue;
      }
      const sourcePath = join(template.root, relativePath);
      const destinationPath = join(targetDir, relativePath);
      const raw = await Bun.file(sourcePath).text();
      const rendered = renderTemplate(raw, replacements);

      await mkdir(dirname(destinationPath), { recursive: true });
      await Bun.write(destinationPath, rendered);
    }
  }

  await writeLocalEnvFile(targetDir, replacements);
}

function shouldSkipForTarget(target: DeployTarget, templateKind: "shared" | "variant" | "target", relativePath: string) {
  if (target === "workers") {
    if (templateKind === "target") {
      return false;
    }

    if (relativePath === "Dockerfile" || relativePath === "docker-compose.yml") {
      return true;
    }

    if (templateKind === "shared") {
      return (
        relativePath === "service.yaml" ||
        relativePath === "scripts/dev.ts" ||
        relativePath === "scripts/ensure-local-db.ts" ||
        relativePath === "scripts/local-docker.ts" ||
        relativePath === "scripts/local-env.ts" ||
        relativePath === "scripts/seed.ts" ||
        relativePath === "scripts/wait-for-db.ts" ||
        relativePath.startsWith("scripts/cloudrun/")
      );
    }

    return (
      relativePath.startsWith("src/db/") ||
      relativePath.startsWith("src/temporal/") ||
      relativePath.startsWith("src/waitlist/") ||
      relativePath.startsWith("test/") ||
      relativePath.startsWith("migrations/") ||
      relativePath === "scripts/codegen.ts" ||
      relativePath === "scripts/migrate.ts"
    );
  }

  return relativePath.startsWith("scripts/workers/") || relativePath === "wrangler.toml";
}

async function ensureTargetDirectory(targetDir: string) {
  await assertTargetDirectoryIsEmpty(targetDir);
  await mkdir(targetDir, { recursive: true });
}

export async function assertTargetDirectoryIsEmpty(targetDir: string) {
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new DirectoryConflictError(targetDir, entries.sort());
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function collectTemplateFiles(root: string, relative = ""): Promise<string[]> {
  const cwd = join(root, relative);
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];

  for (const entry of entries) {
    const nextRelative = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      files.push(...(await collectTemplateFiles(root, nextRelative)));
      continue;
    }
    files.push(nextRelative);
  }

  return files.sort();
}

function buildReplacements(config: ScaffoldConfig) {
  const example = exampleForProfile(config.profile);
  const serviceAccountBase = compactIdentifier(config.serviceName, 21);
  const runtimeServiceAccount = `${serviceAccountBase}-runtime@${config.gcpProject}.iam.gserviceaccount.com`;
  const previewBranchPrefix = `${config.serviceName}-pr`;
  const personalBranchPrefix = `${config.serviceName}-dev`;
  const localDatabaseName = compactDatabaseName(config.serviceName);
  const localDatabasePort = deriveLocalPostgresPort(config.serviceName);
  const authIssuer = "https://auth.anmho.com/api/auth";
  const authAudience = `api://${config.serviceName}`;
  const authJwksUrl = `${authIssuer}/jwks`;

  return {
    SERVICE_NAME: config.serviceName,
    SERVICE_ID: config.serviceName,
    MODULE_PATH: config.modulePath,
    TARGET: config.target,
    PROJECT_ID: config.gcpProject,
    PROJECT_NAME: config.gcpProjectName,
    REGION: config.region,
    GCP_PROJECT_MODE: config.gcpProjectMode,
    PROJECT_CREATE_IF_MISSING: String(config.gcpProjectMode === "create_new"),
    BILLING_ACCOUNT: config.billingAccount,
    QUOTA_PROJECT_ID: config.quotaProjectId,
    AUTO_DEPLOY: String(config.autoDeploy),
    RUNTIME: config.runtime,
    FRAMEWORK: config.framework,
    PROFILE: config.profile,
    EXAMPLE_KIND: example.kind,
    EXAMPLE_DOMAIN: example.domain,
    EXAMPLE_LABEL: example.label,
    CLOUD_RUN_SERVICE: config.serviceName,
    NEON_PROJECT_ID: "",
    NEON_BASE_BRANCH_ID: "",
    NEON_BASE_BRANCH_NAME: "main",
    NEON_DATABASE_NAME: config.neonDatabaseName,
    NEON_ROLE_NAME: "neondb_owner",
    NEON_PREVIEW_BRANCH_PREFIX: previewBranchPrefix,
    NEON_PERSONAL_BRANCH_PREFIX: personalBranchPrefix,
    RUNTIME_SERVICE_ACCOUNT: runtimeServiceAccount,
    API_HOSTNAME: config.apiHostname,
    API_BASE_DOMAIN: "anmho.com",
    AUTH_ISSUER: authIssuer,
    AUTH_AUDIENCE: authAudience,
    AUTH_JWKS_URL: authJwksUrl,
    LOCAL_DATABASE_NAME: localDatabaseName,
    LOCAL_DATABASE_PORT: localDatabasePort,
    LOCAL_DATABASE_USER: "postgres",
    LOCAL_DATABASE_PASSWORD: "postgres",
    COMMAND_DEV: config.runtime === "bun" ? "bun run dev" : "make dev",
    COMMAND_MIGRATE: config.runtime === "bun" ? "bun run migrate" : "make migrate",
    COMMAND_GEN: config.runtime === "bun" ? "bun run gen" : "make gen",
    COMMAND_LINT: config.runtime === "bun" ? "bun run lint" : "make lint",
    COMMAND_TEST: config.runtime === "bun" ? "bun run test" : "make test",
    COMMAND_BOOTSTRAP: "service create",
    COMMAND_DEPLOY: "service deploy",
    COMMAND_AUTH_RESOURCE: "service auth resource-server",
    COMMAND_AUTH_CLIENT: "service auth client create",
    COMMAND_AUTH_TOKEN: "service auth token",
    COMMAND_DEPLOY_PERSONAL: "service deploy --environment personal --name <name>",
    COMMAND_DEPLOY_DESTROY: "service destroy --environment personal --name <name>",
    COMMAND_CLEANUP: "service destroy",
    COMMAND_CLEANUP_PROJECT: "service destroy --project",
    GITIGNORE_EXTRA: "",
    LOCAL_INTROSPECTION_NOTE:
      config.framework === "connectrpc"
        ? [
            "",
            "## Local introspection",
            "",
            "When running locally, ConnectRPC variants expose introspection by default.",
            "",
            "- `go + connectrpc`: standard gRPC reflection for tools like `grpcurl list localhost:<port>`",
            "- `bun + connectrpc`: JSON introspection at `/debug/connectrpc`",
            "- override with `ENABLE_RPC_INTROSPECTION=true|false`",
          ].join("\n")
        : "",
    PRODUCTION_PROTECTED_CHECKS: buildProtectedChecks(config),
  };
}

function buildProtectedChecks(config: ScaffoldConfig) {
  const tokenCommand = 'TOKEN="$(service auth token)"';
  if (config.framework === "connectrpc" && config.runtime === "go") {
    return [
      "After deploy, verify protected reads with:",
      "",
      "```bash",
      tokenCommand,
      `grpcurl -H "Authorization: Bearer $TOKEN" -d '{"limit":1}' -proto protos/waitlist/v1/waitlist.proto ${config.apiHostname}:443 waitlist.v1.WaitlistService/ListWaitlistEntries`,
      "```",
    ].join("\n");
  }
  if (config.framework === "connectrpc") {
    return [
      "After deploy, verify protected reads with:",
      "",
      "```bash",
      tokenCommand,
      `curl --fail --show-error --silent -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"limit":1}' "https://${config.apiHostname}/waitlist.v1.WaitlistService/ListWaitlistEntries"`,
      "```",
    ].join("\n");
  }
  return [
    "After deploy, verify protected reads with:",
    "",
    "```bash",
    tokenCommand,
    `curl --fail --show-error --silent -H "Authorization: Bearer $TOKEN" "https://${config.apiHostname}/v1/admin/waitlist?limit=1"`,
    "```",
  ].join("\n");
}

async function writeLocalEnvFile(targetDir: string, replacements: Record<string, string>) {
  const envPath = join(targetDir, ".env.local");
  if (await Bun.file(envPath).exists()) {
    return;
  }

  const rendered = renderTemplate(
    [
      "# Generated local development defaults for create-service.",
      "# This file is user-owned after scaffold and is gitignored.",
      "",
      "DATABASE_URL=postgres://{{LOCAL_DATABASE_USER}}:{{LOCAL_DATABASE_PASSWORD}}@127.0.0.1:{{LOCAL_DATABASE_PORT}}/{{LOCAL_DATABASE_NAME}}?sslmode=disable",
      "",
      "VAULT_SECRET_MOUNT=secret",
      "VAULT_AUTHCTL_ACCESS_PATH=prod/apps/auth/authctl/cloudflare-access",
      "VAULT_AUTHCTL_ACCESS_BASE_URL_FIELD=AUTH_INTERNAL_BASE_URL",
      "VAULT_AUTHCTL_ACCESS_CLIENT_ID_FIELD=CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_ID",
      "VAULT_AUTHCTL_ACCESS_CLIENT_SECRET_FIELD=CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_SECRET",
      "VAULT_NEON_API_KEY_PATH=prod/providers/neon",
      "VAULT_NEON_API_KEY_FIELD=api_key",
      "VAULT_CLOUDFLARE_API_TOKEN_PATH=prod/providers/cloudflare",
      "VAULT_CLOUDFLARE_API_TOKEN_FIELD=api_token",
      "",
    ].join("\n"),
    replacements
  );

  await Bun.write(envPath, rendered);
}

function renderTemplate(input: string, replacements: Record<string, string>) {
  return input.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => {
    const replacement = replacements[key];
    if (replacement === undefined) {
      throw new Error(`Missing template replacement for ${key}`);
    }
    return replacement;
  });
}
