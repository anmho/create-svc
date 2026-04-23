import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  compactIdentifier,
  type Framework,
  type GcpProjectMode,
  type Runtime,
} from "./naming";

export type ScaffoldConfig = {
  directory: string;
  serviceName: string;
  runtime: Runtime;
  framework: Framework;
  region: string;
  gcpProjectMode: GcpProjectMode;
  gcpProject: string;
  gcpProjectName: string;
  billingAccount: string;
  quotaProjectId: string;
  githubRepo: string;
  githubVisibility: "public" | "private";
  createGithubRepo: boolean;
  autoDeploy: boolean;
  neonProjectId: string;
  neonBaseBranchId: string;
  neonBaseBranchName: string;
  neonDatabaseName: string;
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

  for (const templateRoot of [sharedTemplateRoot, variantTemplateRoot]) {
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
      files.push(...(await collectTemplateFiles(root, nextRelative)));
      continue;
    }
    files.push(nextRelative);
  }

  return files.sort();
}

function buildReplacements(config: ScaffoldConfig) {
  const [githubOwner = "anmho"] = config.githubRepo.split("/");
  const modulePath = `github.com/${config.githubRepo}`;
  const serviceAccountBase = compactIdentifier(config.serviceName, 21);
  const runtimeServiceAccount = `${serviceAccountBase}-runtime@${config.gcpProject}.iam.gserviceaccount.com`;
  const deployerServiceAccount = `${serviceAccountBase}-deployer@${config.gcpProject}.iam.gserviceaccount.com`;
  const wifPoolId = "github";
  const wifProviderId = compactIdentifier(config.serviceName, 32);
  const previewBranchPrefix = `${config.serviceName}-pr`;
  const personalBranchPrefix = `${config.serviceName}-dev`;

  return {
    SERVICE_NAME: config.serviceName,
    MODULE_PATH: modulePath,
    PROJECT_ID: config.gcpProject,
    PROJECT_NAME: config.gcpProjectName,
    REGION: config.region,
    GCP_PROJECT_MODE: config.gcpProjectMode,
    PROJECT_CREATE_IF_MISSING: String(config.gcpProjectMode === "create_new"),
    BILLING_ACCOUNT: config.billingAccount,
    QUOTA_PROJECT_ID: config.quotaProjectId,
    GITHUB_REPO: config.githubRepo,
    GITHUB_OWNER: githubOwner,
    GITHUB_VISIBILITY: config.githubVisibility,
    GITHUB_CREATE_IF_MISSING: String(config.createGithubRepo),
    AUTO_DEPLOY: String(config.autoDeploy),
    RUNTIME: config.runtime,
    FRAMEWORK: config.framework,
    CLOUD_RUN_SERVICE: config.serviceName,
    NEON_PROJECT_ID: config.neonProjectId,
    NEON_BASE_BRANCH_ID: config.neonBaseBranchId,
    NEON_BASE_BRANCH_NAME: config.neonBaseBranchName,
    NEON_DATABASE_NAME: config.neonDatabaseName,
    NEON_ROLE_NAME: "neondb_owner",
    NEON_PREVIEW_BRANCH_PREFIX: previewBranchPrefix,
    NEON_PERSONAL_BRANCH_PREFIX: personalBranchPrefix,
    RUNTIME_SERVICE_ACCOUNT: runtimeServiceAccount,
    DEPLOYER_SERVICE_ACCOUNT: deployerServiceAccount,
    WIF_POOL_ID: wifPoolId,
    WIF_PROVIDER_ID: wifProviderId,
  };
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
