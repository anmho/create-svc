import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  compactIdentifier,
  compactDatabaseName,
  deriveLocalPostgresPort,
  type Framework,
  type GcpProjectMode,
  type Runtime,
} from "./naming";
import { exampleForProfile, type Profile } from "./profiles";

export type ScaffoldConfig = {
  directory: string;
  serviceName: string;
  modulePath: string;
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
  const sharedTemplateRoot = resolve(config.generatorRoot, "templates", "shared");
  const variantTemplateRoot = resolve(config.generatorRoot, "templates", "variants", `${config.runtime}-${config.framework}`);
  const templateRoots = [sharedTemplateRoot, variantTemplateRoot];

  for (const templateRoot of templateRoots) {
    const files = await collectTemplateFiles(templateRoot);

    for (const relativePath of files) {
      const sourcePath = join(templateRoot, relativePath);
      const destinationPath = join(targetDir, relativePath);
      const raw = await Bun.file(sourcePath).text();
      const rendered = renderTemplate(raw, replacements);

      await mkdir(dirname(destinationPath), { recursive: true });
      await Bun.write(destinationPath, rendered);
    }
  }

  await writeLocalEnvFile(targetDir, replacements);
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
  const entries = await readdir(cwd, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const nextRelative = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (nextRelative === ".github" || nextRelative.startsWith(".github/")) {
        continue;
      }
      files.push(...(await collectTemplateFiles(root, nextRelative)));
      continue;
    }
    if (nextRelative === ".github" || nextRelative.startsWith(".github/")) {
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
  const remoteAttachmentBucket = `${config.gcpProject}-${config.serviceName}-attachments`;
  const remoteAttachmentPublicBaseUrl = `https://storage.googleapis.com/${remoteAttachmentBucket}`;
  const localDatabaseName = compactDatabaseName(config.serviceName);
  const localDatabasePort = deriveLocalPostgresPort(config.serviceName);
  const localAttachmentBucket = `${config.serviceName}-local-attachments`;
  const localAttachmentPublicBaseUrl = `https://storage.local.invalid/${localAttachmentBucket}`;

  return {
    SERVICE_NAME: config.serviceName,
    MODULE_PATH: config.modulePath,
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
    ATTACHMENT_BUCKET: remoteAttachmentBucket,
    ATTACHMENT_PUBLIC_BASE_URL: remoteAttachmentPublicBaseUrl,
    LOCAL_DATABASE_NAME: localDatabaseName,
    LOCAL_DATABASE_PORT: localDatabasePort,
    LOCAL_DATABASE_USER: "postgres",
    LOCAL_DATABASE_PASSWORD: "postgres",
    LOCAL_ATTACHMENT_BUCKET: localAttachmentBucket,
    LOCAL_ATTACHMENT_PUBLIC_BASE_URL: localAttachmentPublicBaseUrl,
    COMMAND_DEV: config.runtime === "bun" ? "bun run dev" : "make dev",
    COMMAND_DEV_DOWN: config.runtime === "bun" ? "bun run dev:down" : "make dev-down",
    COMMAND_MIGRATE: config.runtime === "bun" ? "bun run migrate" : "make migrate",
    COMMAND_GEN: config.runtime === "bun" ? "bun run gen" : "make gen",
    COMMAND_LINT: config.runtime === "bun" ? "bun run lint" : "make lint",
    COMMAND_TEST: config.runtime === "bun" ? "bun run test" : "make test",
    COMMAND_BOOTSTRAP: config.runtime === "bun" ? "bun run bootstrap" : "make bootstrap",
    COMMAND_DEPLOY: config.runtime === "bun" ? "bun run deploy" : "make deploy",
    COMMAND_DEPLOY_PERSONAL:
      config.runtime === "bun"
        ? 'bun run deploy -- --environment personal --name <slug>'
        : 'make deploy ARGS="--environment personal --name <slug>"',
    COMMAND_DEPLOY_DESTROY:
      config.runtime === "bun"
        ? 'bun run deploy -- --destroy --environment personal --name <slug>'
        : 'make deploy ARGS="--destroy --environment personal --name <slug>"',
    COMMAND_CLEANUP: config.runtime === "bun" ? "bun run cleanup" : "make cleanup",
    COMMAND_CLEANUP_PROJECT: config.runtime === "bun" ? "bun run cleanup -- --project" : 'make cleanup ARGS="--project"',
    GITIGNORE_EXTRA: config.framework === "connectrpc" ? "gen/" : "",
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
  };
}

async function writeLocalEnvFile(targetDir: string, replacements: Record<string, string>) {
  const envPath = join(targetDir, ".env.local");
  if (await Bun.file(envPath).exists()) {
    return;
  }

  const rendered = renderTemplate(
    [
      "# Generated local development defaults for create-svc.",
      "# This file is user-owned after scaffold and is gitignored.",
      "",
      "DATABASE_URL=postgres://{{LOCAL_DATABASE_USER}}:{{LOCAL_DATABASE_PASSWORD}}@127.0.0.1:{{LOCAL_DATABASE_PORT}}/{{LOCAL_DATABASE_NAME}}",
      "ATTACHMENT_BUCKET={{LOCAL_ATTACHMENT_BUCKET}}",
      "ATTACHMENT_PUBLIC_BASE_URL={{LOCAL_ATTACHMENT_PUBLIC_BASE_URL}}",
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
