import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ScaffoldConfig = {
  directory: string;
  serviceName: string;
  modulePath: string;
  projectId: string;
  region: string;
  githubRepo: string;
  vaultAddr: string;
  vaultSecretPath: string;
  vaultSecretKey: string;
  cloudflareZoneId: string;
  bufModule: string;
  generatorRoot: string;
};

export async function scaffoldProject(config: ScaffoldConfig) {
  const targetDir = resolve(process.cwd(), config.directory);
  await ensureTargetDirectory(targetDir);

  const replacements = buildReplacements(config);
  const templateRoot = resolve(config.generatorRoot, "templates", "root");
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

async function ensureTargetDirectory(targetDir: string) {
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(`Target directory already exists and is not empty: ${targetDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(targetDir, { recursive: true });
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
  const [repoOwner = "anmho"] = config.githubRepo.split("/");
  const runtimeServiceAccount = `${config.serviceName}-runtime@${config.projectId}.iam.gserviceaccount.com`;
  const deployerServiceAccount = `${config.serviceName}-deployer@${config.projectId}.iam.gserviceaccount.com`;
  const vaultRoleIdSecret = `${config.serviceName}-vault-role-id`;
  const vaultSecretIdSecret = `${config.serviceName}-vault-secret-id`;
  const wifPoolId = "github";
  const wifProviderId = config.serviceName;

  return {
    SERVICE_NAME: config.serviceName,
    MODULE_PATH: config.modulePath,
    PROJECT_ID: config.projectId,
    REGION: config.region,
    GITHUB_REPO: config.githubRepo,
    GITHUB_OWNER: repoOwner,
    VAULT_ADDR: config.vaultAddr,
    VAULT_SECRET_PATH: config.vaultSecretPath,
    VAULT_SECRET_KEY: config.vaultSecretKey,
    CLOUDFLARE_ZONE_ID: config.cloudflareZoneId,
    BUF_MODULE: config.bufModule,
    RUNTIME_SERVICE_ACCOUNT: runtimeServiceAccount,
    DEPLOYER_SERVICE_ACCOUNT: deployerServiceAccount,
    VAULT_ROLE_ID_SECRET: vaultRoleIdSecret,
    VAULT_SECRET_ID_SECRET: vaultSecretIdSecret,
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
