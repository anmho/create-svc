import { intro, log, outro, spinner } from "@clack/prompts";
import { config } from "./config";

type CommandOptions = {
  allowFailure?: boolean;
  input?: string;
  env?: Record<string, string | undefined>;
};

type DeployArgs = {
  ci: boolean;
  destroy: boolean;
  environment: "main" | "preview" | "personal";
  name?: string;
};

type CleanupArgs = {
  destroyProject: boolean;
  force: boolean;
};

export type DeploymentTarget = {
  environment: "main" | "preview" | "personal";
  serviceName: string;
  branchName: string;
  databaseSecretName: string;
};

type GcpResourceWithLabels = {
  metadata?: {
    labels?: Record<string, string>;
  };
  labels?: Record<string, string>;
};

type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

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

export function requireGcloudAuth() {
  const activeAccount = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], {
    allowFailure: true,
  }).stdout.trim();

  if (!activeAccount) {
    throw new Error(
      [
        "gcloud is installed but no active Google Cloud account is available.",
        "Run `gcloud auth login` on this machine before using service create, deploy, doctor, dns, or destroy.",
        "If you also rely on Application Default Credentials for other tooling, run `gcloud auth application-default login` as well.",
      ].join(" ")
    );
  }
}

export function run(command: string, args: string[], options: CommandOptions = {}): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdin: options.input === undefined ? undefined : encoder.encode(options.input),
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

export async function runMain(name: string, task: () => Promise<string | void> | string | void) {
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

  gcloud([
    "secrets",
    "create",
    secretName,
    "--project",
    config.project.id,
    "--replication-policy",
    "automatic",
    "--labels",
    ownershipLabelsArg(),
  ]);
}

export function addSecretVersion(secretName: string, value: string) {
  ensureSecret(secretName);
  gcloud(["secrets", "versions", "add", secretName, "--project", config.project.id, "--data-file=-"], { input: value });
}

export function accessSecretVersion(secretName: string) {
  return gcloud(["secrets", "versions", "access", "latest", "--secret", secretName, "--project", config.project.id]).stdout;
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

export function describeSecret(secretName: string): GcpResourceWithLabels | undefined {
  const result = gcloud(["secrets", "describe", secretName, "--project", config.project.id, "--format=json"], { allowFailure: true });
  return parseOptionalJson(result.stdout, result.success);
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
    force: false,
  };

  for (const token of argv) {
    if (token === "--project") {
      parsed.destroyProject = true;
      continue;
    }
    if (token === "--force") {
      parsed.force = true;
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
  const temporal = resolveTemporalRuntimeConfig();
  const values = {
    SERVICE_NAME: target.serviceName,
    SERVICE_ID: config.serviceName,
    RUNTIME_SERVICE_ACCOUNT: config.runtimeServiceAccount,
    IMAGE_URL: image,
    DATABASE_URL_SECRET: target.databaseSecretName,
    SERVICE_RUNTIME: config.runtime,
    SERVICE_FRAMEWORK: config.framework,
    TEMPORAL_ENABLED: String(temporal.enabled),
    TEMPORAL_ADDRESS: temporal.address,
    TEMPORAL_NAMESPACE: temporal.namespace,
    TEMPORAL_TASK_QUEUE: temporal.taskQueue,
    TEMPORAL_API_KEY_ENV: temporal.apiKeySecretName
      ? [
          "            - name: TEMPORAL_API_KEY",
          "              valueFrom:",
          "                secretKeyRef:",
          `                  name: ${temporal.apiKeySecretName}`,
          "                  key: latest",
        ].join("\n")
      : "",
    AUTH_ISSUER: config.auth.issuer,
    AUTH_AUDIENCE: config.auth.audience,
    AUTH_JWKS_URL: config.auth.jwksUrl,
  };

  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
    const value = values[key as keyof typeof values];
    if (!value) {
      throw new Error(`missing manifest value for ${key}`);
    }
    return value;
  });
}

export function resolveTemporalRuntimeConfig() {
  const enabledOverride = process.env.TEMPORAL_ENABLED?.trim();
  const address = process.env.TEMPORAL_ADDRESS?.trim() || config.temporal.address;
  const namespace = process.env.TEMPORAL_NAMESPACE?.trim() || config.temporal.namespace;
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE?.trim() || config.temporal.taskQueue;
  const apiKeySecretName = process.env.TEMPORAL_API_KEY_SECRET?.trim() || (process.env.TEMPORAL_API_KEY?.trim() ? config.temporal.apiKeySecretName : "");
  const enabled = enabledOverride
    ? ["1", "true", "yes", "on"].includes(enabledOverride.toLowerCase())
    : Boolean(process.env.TEMPORAL_ADDRESS?.trim() || process.env.TEMPORAL_API_KEY?.trim() || process.env.TEMPORAL_API_KEY_SECRET?.trim());

  return {
    enabled,
    address,
    namespace,
    taskQueue,
    apiKeySecretName,
  };
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

export function serviceDomain(target: DeploymentTarget) {
  if (target.environment === "main") {
    return config.domain.hostname;
  }

  return `${target.serviceName}-${config.project.id}-${config.region}.a.run.app`;
}

export function serviceOrigin(target: DeploymentTarget) {
  if (target.environment === "main") {
    return `https://${config.domain.hostname}`;
  }

  const url = serviceUrl(target.serviceName);
  return url || `https://${serviceDomain(target)}`;
}

export function ensureProductionDomainMapping(serviceName: string) {
  const existing = describeProductionDomainMapping();
  if (existing) {
    const mappedService = existing.spec?.routeName ?? existing.status?.resourceRecords?.[0]?.rrdata;
    if (!mappedService || mappedService === serviceName) {
      return;
    }
    throw new Error(`${config.domain.hostname} is already mapped to ${mappedService}; refusing to take it over`);
  }

  gcloud([
    "beta",
    "run",
    "domain-mappings",
    "create",
    "--service",
    serviceName,
    "--domain",
    config.domain.hostname,
    "--project",
    config.project.id,
    "--region",
    config.region,
  ]);
}

export function describeProductionDomainMapping():
  | { spec?: { routeName?: string }; status?: { resourceRecords?: Array<{ rrdata?: string }> } }
  | undefined {
  const result = gcloud(
    ["beta", "run", "domain-mappings", "describe", "--domain", config.domain.hostname, "--project", config.project.id, "--format=json"],
    { allowFailure: true }
  );
  if (!result.success || !result.stdout) {
    return undefined;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Unable to parse Cloud Run domain mapping for ${config.domain.hostname}`);
  }
}

export function assertProductionDomainAvailable(serviceName: string) {
  const existing = describeProductionDomainMapping();
  if (!existing) {
    return;
  }

  const mappedService = existing.spec?.routeName;
  if (mappedService && mappedService !== serviceName) {
    throw new Error(`${config.domain.hostname} is already mapped to ${mappedService}; choose a different service_id before provisioning resources`);
  }

  throw new Error(`${config.domain.hostname} already has a domain mapping; use service deploy to redeploy or service dns to repair it`);
}

export function assertServiceNameAvailable(serviceName: string) {
  const result = gcloud(
    ["run", "services", "describe", serviceName, "--project", config.project.id, "--region", config.region, "--format=value(metadata.name)"],
    { allowFailure: true }
  );
  if (result.success) {
    throw new Error(`${serviceName} already exists in Cloud Run; use service deploy to redeploy or service destroy to remove owned resources`);
  }
}

export function deleteProductionDomainMapping() {
  gcloud(["beta", "run", "domain-mappings", "delete", "--domain", config.domain.hostname, "--project", config.project.id, "--quiet"], {
    allowFailure: true,
  });
}

export function listCloudRunServices() {
  return gcloud(["run", "services", "list", "--project", config.project.id, "--region", config.region, "--format=value(metadata.name)"]).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function describeCloudRunService(serviceName: string): GcpResourceWithLabels | undefined {
  const result = gcloud(
    ["run", "services", "describe", serviceName, "--project", config.project.id, "--region", config.region, "--format=json"],
    { allowFailure: true }
  );
  return parseOptionalJson(result.stdout, result.success);
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

export function assertOwnedResource(name: string, resource: GcpResourceWithLabels | undefined) {
  if (!resource) {
    throw new Error(`${name} does not exist`);
  }

  const labels = resource.metadata?.labels ?? resource.labels ?? {};
  if (labels.managed_by !== "create-service" || labels.service_id !== config.serviceName) {
    throw new Error(`${name} is missing ownership labels for service_id=${config.serviceName}`);
  }
}

function ownershipLabelsArg() {
  return `managed_by=create-service,service_id=${config.serviceName}`;
}

function parseOptionalJson<T>(stdout: string, success: boolean): T | undefined {
  if (!success || !stdout) {
    return undefined;
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error("Unable to parse gcloud JSON response");
  }
}
