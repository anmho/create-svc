import { intro, log, outro, spinner } from "@clack/prompts";
import { config } from "./config";

type CommandOptions = {
  allowFailure?: boolean;
  input?: string;
};

type DeployArgs = {
  ci: boolean;
  destroy: boolean;
  environment: "main" | "preview" | "personal";
  name?: string;
};

type CleanupArgs = {
  destroyProject: boolean;
  destroyRepo: boolean;
};

type DeploymentTarget = {
  environment: "main" | "preview" | "personal";
  serviceName: string;
  branchName: string;
  databaseSecretName: string;
};

type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const decoder = new TextDecoder();

export class CommandError extends Error {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;

  constructor(command: string, args: string[], result: CommandResult) {
    super(`command failed: ${command} ${args.join(" ")}`);
    this.name = "CommandError";
    this.command = command;
    this.args = args;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}

export function requireCommand(name: string) {
  if (!Bun.which(name)) {
    throw new Error(`missing required command: ${name}`);
  }
}

export function run(command: string, args: string[], options: CommandOptions = {}): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: options.input,
    stdout: "pipe",
    stderr: "pipe",
  });

  const commandResult: CommandResult = {
    success: result.success,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : "",
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : "",
    exitCode: result.exitCode,
  };

  if (!commandResult.success && !options.allowFailure) {
    throw new CommandError(command, args, commandResult);
  }

  return commandResult;
}

export function gcloud(args: string[], options: CommandOptions = {}) {
  const normalized = [...args];
  if (config.project.quotaProjectId && !normalized.includes("--billing-project")) {
    normalized.push("--billing-project", config.project.quotaProjectId);
  }
  return run("gcloud", normalized, options);
}

export function gh(args: string[], options: CommandOptions = {}) {
  return run("gh", args, options);
}

export async function runStep<T>(label: string, task: () => Promise<T> | T) {
  const indicator = spinner();
  indicator.start(label);

  try {
    const result = await task();
    indicator.stop(label);
    return result;
  } catch (error) {
    indicator.stop(`${label} failed`);
    throw new Error(`${label} failed\n${formatError(error)}`);
  }
}

export async function runMain(name: string, task: () => Promise<string | void>) {
  intro(name);

  try {
    const message = await task();
    outro(message || "Done");
  } catch (error) {
    log.error(formatError(error));
    process.exit(1);
  }
}

export function formatError(error: unknown) {
  if (error instanceof CommandError) {
    return [error.message, error.stderr || error.stdout].filter(Boolean).join("\n");
  }

  return error instanceof Error ? error.message : String(error);
}

export function ensureProject() {
  if (gcloud(["projects", "describe", config.project.id], { allowFailure: true }).success) {
    return;
  }

  if (!config.project.createIfMissing) {
    throw new Error(`GCP project ${config.project.id} does not exist and createIfMissing is false`);
  }

  gcloud(["projects", "create", config.project.id, "--name", config.project.name]);
}

export function attachBilling() {
  gcloud(["beta", "billing", "projects", "link", config.project.id, "--billing-account", config.project.billingAccount]);
}

export function ensureServiceAccount(email: string) {
  if (gcloud(["iam", "service-accounts", "describe", email, "--project", config.project.id], { allowFailure: true }).success) {
    return;
  }

  const accountId = email.split("@")[0] ?? email;
  gcloud(["iam", "service-accounts", "create", accountId, "--project", config.project.id, "--display-name", accountId]);
}

export function deleteServiceAccount(email: string) {
  gcloud(["iam", "service-accounts", "delete", email, "--project", config.project.id, "--quiet"], { allowFailure: true });
}

export function ensureProjectRole(member: string, role: string) {
  gcloud(["projects", "add-iam-policy-binding", config.project.id, "--member", member, "--role", role]);
}

export function ensureServiceAccountRole(serviceAccount: string, member: string, role: string) {
  gcloud([
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    serviceAccount,
    "--project",
    config.project.id,
    "--member",
    member,
    "--role",
    role,
  ]);
}

export function ensureSecret(secretName: string) {
  if (gcloud(["secrets", "describe", secretName, "--project", config.project.id], { allowFailure: true }).success) {
    return;
  }

  gcloud(["secrets", "create", secretName, "--project", config.project.id, "--replication-policy", "automatic"]);
}

export function addSecretVersion(secretName: string, value: string) {
  ensureSecret(secretName);
  gcloud(["secrets", "versions", "add", secretName, "--project", config.project.id, "--data-file=-"], { input: value });
}

export function ensureSecretAccessor(secretName: string, member: string) {
  gcloud(["secrets", "add-iam-policy-binding", secretName, "--project", config.project.id, "--member", member, "--role", "roles/secretmanager.secretAccessor"]);
}

export function listSecrets() {
  return gcloud(["secrets", "list", "--project", config.project.id, "--format=value(name)"]).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => name.split("/").pop() ?? name);
}

export function deleteSecret(secretName: string) {
  gcloud(["secrets", "delete", secretName, "--project", config.project.id, "--quiet"], { allowFailure: true });
}

export function ensureArtifactRepository() {
  if (
    gcloud(
      ["artifacts", "repositories", "describe", config.artifactRepository, "--project", config.project.id, "--location", config.region],
      { allowFailure: true }
    ).success
  ) {
    return;
  }

  gcloud([
    "artifacts",
    "repositories",
    "create",
    config.artifactRepository,
    "--project",
    config.project.id,
    "--location",
    config.region,
    "--repository-format",
    "docker",
  ]);
}

export function projectNumber() {
  return gcloud(["projects", "describe", config.project.id, "--format=value(projectNumber)"]).stdout;
}

export function workloadIdentityPoolResource() {
  return `projects/${projectNumber()}/locations/global/workloadIdentityPools/${config.workloadIdentityPoolId}`;
}

export function workloadIdentityProviderResource() {
  return `${workloadIdentityPoolResource()}/providers/${config.workloadIdentityProviderId}`;
}

export function ensureWorkloadIdentityPool() {
  if (
    gcloud(["iam", "workload-identity-pools", "describe", config.workloadIdentityPoolId, "--project", config.project.id, "--location", "global"], {
      allowFailure: true,
    }).success
  ) {
    return;
  }

  gcloud([
    "iam",
    "workload-identity-pools",
    "create",
    config.workloadIdentityPoolId,
    "--project",
    config.project.id,
    "--location",
    "global",
    "--display-name",
    "GitHub Actions",
  ]);
}

export function ensureWorkloadIdentityProvider() {
  if (
    gcloud(
      [
        "iam",
        "workload-identity-pools",
        "providers",
        "describe",
        config.workloadIdentityProviderId,
        "--project",
        config.project.id,
        "--location",
        "global",
        "--workload-identity-pool",
        config.workloadIdentityPoolId,
      ],
      { allowFailure: true }
    ).success
  ) {
    return;
  }

  gcloud([
    "iam",
    "workload-identity-pools",
    "providers",
    "create-oidc",
    config.workloadIdentityProviderId,
    "--project",
    config.project.id,
    "--location",
    "global",
    "--workload-identity-pool",
    config.workloadIdentityPoolId,
    "--display-name",
    `${config.serviceName} GitHub`,
    "--issuer-uri",
    "https://token.actions.githubusercontent.com",
    "--attribute-mapping",
    "google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner",
    "--attribute-condition",
    `assertion.repository=='${config.github.repo}'`,
  ]);
}

export function deleteWorkloadIdentityProvider() {
  gcloud(
    [
      "iam",
      "workload-identity-pools",
      "providers",
      "delete",
      config.workloadIdentityProviderId,
      "--project",
      config.project.id,
      "--location",
      "global",
      "--workload-identity-pool",
      config.workloadIdentityPoolId,
      "--quiet",
    ],
    { allowFailure: true }
  );
}

export function setGithubVariable(name: string, value: string) {
  gh(["variable", "set", name, "--repo", config.github.repo, "--body", value]);
}

export function deleteGithubVariable(name: string) {
  gh(["variable", "delete", name, "--repo", config.github.repo], { allowFailure: true });
}

export function deleteGithubRepository() {
  gh(["repo", "delete", config.github.repo, "--yes"]);
}

export function imageTag() {
  const gitSha = run("git", ["rev-parse", "--short", "HEAD"], { allowFailure: true }).stdout;
  return gitSha || `${Date.now()}`;
}

export function imageUrl(tag = imageTag()) {
  return `${config.region}-docker.pkg.dev/${config.project.id}/${config.artifactRepository}/${config.serviceName}:${tag}`;
}

export function parseDeployArgs(argv: string[]): DeployArgs {
  const parsed: DeployArgs = {
    ci: false,
    destroy: false,
    environment: "main",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) {
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

    if (token === "--ci") {
      parsed.ci = true;
      continue;
    }

    if (token === "--destroy") {
      parsed.destroy = true;
      continue;
    }

    if (token === "--environment") {
      parsed.environment = readValue() as DeployArgs["environment"];
      continue;
    }

    if (token.startsWith("--environment=")) {
      parsed.environment = token.slice("--environment=".length) as DeployArgs["environment"];
      continue;
    }

    if (token === "--name") {
      parsed.name = readValue();
      continue;
    }

    if (token.startsWith("--name=")) {
      parsed.name = token.slice("--name=".length);
      continue;
    }
  }

  return parsed;
}

export function parseCleanupArgs(argv: string[]): CleanupArgs {
  const parsed: CleanupArgs = {
    destroyProject: false,
    destroyRepo: false,
  };

  for (const token of argv) {
    if (token === "--project") {
      parsed.destroyProject = true;
      continue;
    }

    if (token === "--repo") {
      parsed.destroyRepo = true;
      continue;
    }
  }

  return parsed;
}

export function resolveDeploymentTarget(environment: DeployArgs["environment"], rawName?: string): DeploymentTarget {
  if (environment === "main") {
    return {
      environment,
      serviceName: config.serviceName,
      branchName: config.neon.baseBranchName,
      databaseSecretName: `${config.serviceName}-database-url`,
    };
  }

  const slug = slugify(rawName || "");
  if (!slug) {
    throw new Error(`A name is required for ${environment} deployments`);
  }

  if (environment === "preview") {
    return {
      environment,
      serviceName: `${config.serviceName}-pr-${slug}`,
      branchName: `${config.neon.previewBranchPrefix}-${slug}`,
      databaseSecretName: `${config.serviceName}-pr-${slug}-database-url`,
    };
  }

  return {
    environment,
    serviceName: `${config.serviceName}-dev-${slug}`,
    branchName: `${config.neon.personalBranchPrefix}-${slug}`,
    databaseSecretName: `${config.serviceName}-dev-${slug}-database-url`,
  };
}

export async function renderManifest(image: string, target: DeploymentTarget) {
  const template = await Bun.file(new URL("../../service.yaml", import.meta.url)).text();
  const values = {
    SERVICE_NAME: target.serviceName,
    RUNTIME_SERVICE_ACCOUNT: config.runtimeServiceAccount,
    IMAGE_URL: image,
    DATABASE_URL_SECRET: target.databaseSecretName,
    SERVICE_RUNTIME: config.runtime,
    SERVICE_FRAMEWORK: config.framework,
  };

  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
    const value = values[key as keyof typeof values];
    if (!value) {
      throw new Error(`missing manifest value for ${key}`);
    }
    return value;
  });
}

export async function writeRenderedManifest(image: string, target: DeploymentTarget) {
  const rendered = await renderManifest(image, target);
  const path = new URL("../../.cloudrun.rendered.yaml", import.meta.url);
  await Bun.write(path, rendered);
  return path;
}

export function serviceUrl(serviceName: string) {
  return gcloud(
    ["run", "services", "describe", serviceName, "--project", config.project.id, "--region", config.region, "--format=value(status.url)"]
  ).stdout;
}

export function listCloudRunServices() {
  return gcloud(["run", "services", "list", "--project", config.project.id, "--region", config.region, "--format=value(metadata.name)"]).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function deleteService(serviceName: string) {
  gcloud(["run", "services", "delete", serviceName, "--project", config.project.id, "--region", config.region, "--quiet"], {
    allowFailure: true,
  });
}

export function deleteProject() {
  gcloud(["projects", "delete", config.project.id, "--quiet"]);
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
