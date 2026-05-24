import { intro, log, outro, spinner } from "@clack/prompts";
import { join } from "node:path";
import { config } from "./config";
import { serviceRoot } from "../runtime";

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
const CLOUDFLARE_DNS_TTL_AUTO = 1;

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

export async function gcloudStreaming(args: string[], options: CommandOptions = {}) {
  const normalized = [...args];
  if (config.project.quotaProjectId && !normalized.includes("--billing-project")) {
    normalized.push("--billing-project", config.project.quotaProjectId);
  }
  return runStreaming("gcloud", normalized, options);
}

export async function runStreaming(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdin: options.input === undefined ? undefined : encoder.encode(options.input),
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = {
    stdout: "",
    stderr: "",
    buildUrlPrinted: false,
  };
  await Promise.all([
    captureStream(child.stdout, (chunk) => {
      output.stdout += chunk;
      printCloudBuildUrl(chunk, output);
    }),
    captureStream(child.stderr, (chunk) => {
      output.stderr += chunk;
      printCloudBuildUrl(chunk, output);
    }),
  ]);
  const exitCode = await child.exited;
  const result: CommandResult = {
    success: exitCode === 0,
    stdout: output.stdout.trim(),
    stderr: output.stderr.trim(),
    exitCode,
  };

  if (!result.success && !options.allowFailure) {
    throw new CommandError(command, args, result);
  }

  return result;
}

async function captureStream(stream: ReadableStream<Uint8Array> | null, onChunk: (chunk: string) => void) {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const streamDecoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    onChunk(streamDecoder.decode(value, { stream: true }));
  }
  const remaining = streamDecoder.decode();
  if (remaining) {
    onChunk(remaining);
  }
}

function printCloudBuildUrl(chunk: string, output: { stdout: string; stderr: string; buildUrlPrinted: boolean }) {
  if (output.buildUrlPrinted) {
    return;
  }
  const combined = `${output.stdout}\n${output.stderr}\n${chunk}`;
  const match = combined.match(/https:\/\/console\.cloud\.google\.com\/cloud-build\/[^\s)]+/);
  if (!match?.[0]) {
    return;
  }
  output.buildUrlPrinted = true;
  log.step(`Cloud Build logs: ${match[0]}`);
}

export function gcloudWithRetry(args: string[], options: CommandOptions = {}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      return gcloud(args, options);
    } catch (error) {
      lastError = error;
      if (attempt === 12 || !isRetryableGcloudError(error)) {
        break;
      }
      Bun.sleepSync(5_000);
    }
  }
  throw lastError;
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
  const projectMode = config.project.mode as "create_new" | "use_existing";
  if (projectMode === "use_existing") {
    return "Using existing project billing";
  }
  gcloud(["beta", "billing", "projects", "link", config.project.id, "--billing-account", config.project.billingAccount]);
}

export function ensureRequiredApis() {
  const enabled = new Set(
    gcloud(["services", "list", "--enabled", "--project", config.project.id, "--format=value(config.name)"]).stdout
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const missing = config.requiredApis.filter((api: string) => !enabled.has(api));
  if (missing.length === 0) {
    return "Required GCP APIs are already enabled";
  }
  gcloud(["services", "enable", ...missing, "--project", config.project.id]);
  return `Enabled ${missing.join(", ")}`;
}

export function ensureServiceAccount(email: string) {
  if (gcloud(["iam", "service-accounts", "describe", email, "--project", config.project.id], { allowFailure: true }).success) {
    return;
  }

  const accountId = email.split("@")[0] ?? email;
  gcloud(["iam", "service-accounts", "create", accountId, "--project", config.project.id, "--display-name", accountId]);
  waitForServiceAccount(email);
}

export function deleteServiceAccount(email: string) {
  gcloud(["iam", "service-accounts", "delete", email, "--project", config.project.id, "--quiet"], { allowFailure: true });
}

export function ensureProjectRole(member: string, role: string) {
  if (projectHasRole(member, role)) {
    return;
  }
  gcloudWithRetry(["projects", "add-iam-policy-binding", config.project.id, "--member", member, "--role", role]);
}

function projectHasRole(member: string, role: string) {
  return gcloud(
    [
      "projects",
      "get-iam-policy",
      config.project.id,
      "--flatten=bindings[].members",
      `--filter=bindings.role=${role} AND bindings.members=${member}`,
      "--format=value(bindings.role)",
    ],
    { allowFailure: true }
  )
    .stdout.split("\n")
    .some((line) => line.trim() === role);
}

export function ensureServiceAccountRole(serviceAccount: string, member: string, role: string) {
  gcloudWithRetry([
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
  gcloudWithRetry([
    "secrets",
    "add-iam-policy-binding",
    secretName,
    "--project",
    config.project.id,
    "--member",
    member,
    "--role",
    "roles/secretmanager.secretAccessor",
  ]);
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

export function artifactImageBase() {
  return `${config.region}-docker.pkg.dev/${config.project.id}/${config.artifactRepository}/${config.serviceName}`;
}

export function listArtifactImages() {
  const result = gcloud(
    ["artifacts", "docker", "images", "list", artifactImageBase(), "--include-tags", "--project", config.project.id, "--format=json"],
    { allowFailure: true }
  );
  if (!result.success || !result.stdout) {
    return [];
  }

  try {
    return (JSON.parse(result.stdout) as Array<{ package?: string; version?: string }>)
      .map((image) => (image.package && image.version ? `${image.package}@${image.version}` : ""))
      .filter(Boolean);
  } catch {
    throw new Error(`Unable to parse Artifact Registry images for ${artifactImageBase()}`);
  }
}

export function deleteArtifactImage(image: string) {
  gcloud(["artifacts", "docker", "images", "delete", image, "--delete-tags", "--project", config.project.id, "--quiet"], { allowFailure: true });
}

export function projectNumber() {
  return gcloud(["projects", "describe", config.project.id, "--format=value(projectNumber)"]).stdout;
}

export function imageTag() {
  const gitSha = run("git", ["rev-parse", "--short", "HEAD"], { allowFailure: true }).stdout;
  return gitSha || `${Date.now()}`;
}

export function imageUrl(tag = imageTag()) {
  return `${artifactImageBase()}:${tag}`;
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
  const template = await Bun.file(join(serviceRoot, "service.yaml")).text();
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
    if (value === undefined) {
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
      ensureCloudflareDnsRecord(existing);
      return;
    }
    throw new Error(`${config.domain.hostname} is already mapped to ${mappedService}; refusing to take it over`);
  }

  const result = gcloud([
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
  const created = parseDomainMappingOutput(result.stdout) ?? describeProductionDomainMapping();
  ensureCloudflareDnsRecord(created);
}

export function describeProductionDomainMapping():
  | { spec?: { routeName?: string }; status?: { resourceRecords?: Array<{ rrdata?: string }> } }
  | undefined {
  const result = gcloud(
    [
      "beta",
      "run",
      "domain-mappings",
      "describe",
      "--domain",
      config.domain.hostname,
      "--project",
      config.project.id,
      "--region",
      config.region,
      "--format=json",
    ],
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
  deleteCloudflareDnsRecord();
  gcloud(
    [
      "beta",
      "run",
      "domain-mappings",
      "delete",
      "--domain",
      config.domain.hostname,
      "--project",
      config.project.id,
      "--region",
      config.region,
      "--quiet",
    ],
    {
      allowFailure: true,
    }
  );
}

export function listCloudRunServices() {
  return gcloud(["run", "services", "list", "--project", config.project.id, "--region", config.region, "--format=value(metadata.name)"]).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseDomainMappingOutput(stdout: string) {
  if (!stdout.trim().startsWith("{")) {
    return undefined;
  }
  try {
    return JSON.parse(stdout) as ReturnType<typeof describeProductionDomainMapping>;
  } catch {
    return undefined;
  }
}

function ensureCloudflareDnsRecord(
  mapping:
    | { status?: { resourceRecords?: Array<{ name?: string; rrdata?: string; type?: string }> } }
    | undefined
) {
  const desired = desiredCloudflareRecord(mapping);
  const zoneId = cloudflareZoneId();
  const records = listCloudflareDnsRecords(zoneId, config.domain.hostname);
  const conflicting = records.find((record) => record.type !== desired.type);
  if (conflicting) {
    throw new Error(
      `Cloudflare DNS record ${config.domain.hostname} already exists as ${conflicting.type}; remove or update it before provisioning`
    );
  }
  const existing = records.find((record) => record.type === desired.type);
  if (!existing) {
    cloudflareFetch("POST", `/zones/${zoneId}/dns_records`, desired);
    return;
  }
  if (existing.content === desired.content && existing.proxied === desired.proxied) {
    return;
  }
  cloudflareFetch("PUT", `/zones/${zoneId}/dns_records/${existing.id}`, desired);
}

function deleteCloudflareDnsRecord() {
  const token = resolveCloudflareApiToken({ required: false });
  if (!token) {
    return;
  }
  const zoneId = cloudflareZoneId(token);
  const records = listCloudflareDnsRecords(zoneId, config.domain.hostname, token);
  for (const record of records) {
    cloudflareFetch("DELETE", `/zones/${zoneId}/dns_records/${record.id}`, undefined, token);
  }
}

function desiredCloudflareRecord(
  mapping:
    | { status?: { resourceRecords?: Array<{ name?: string; rrdata?: string; type?: string }> } }
    | undefined
) {
  const cname = mapping?.status?.resourceRecords?.find((record) => record.type === "CNAME" && record.rrdata);
  const content = (cname?.rrdata ?? "ghs.googlehosted.com.").replace(/\.$/, "");
  return {
    type: "CNAME",
    name: config.domain.hostname,
    content,
    ttl: CLOUDFLARE_DNS_TTL_AUTO,
    proxied: false,
  };
}

function cloudflareZoneId(token = resolveCloudflareApiToken({ required: true })) {
  const response = cloudflareFetch("GET", `/zones?name=${encodeURIComponent(config.domain.baseDomain)}`, undefined, token);
  const zone = response.result?.[0] as { id?: string } | undefined;
  if (!zone?.id) {
    throw new Error(`Cloudflare zone not found for ${config.domain.baseDomain}`);
  }
  return zone.id;
}

function listCloudflareDnsRecords(zoneId: string, name: string, token = resolveCloudflareApiToken({ required: true })) {
  const response = cloudflareFetch(
    "GET",
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
    undefined,
    token
  );
  return (response.result ?? []) as Array<{ id: string; type: string; content: string; proxied: boolean }>;
}

function cloudflareFetch(method: string, path: string, body?: unknown, token = resolveCloudflareApiToken({ required: true })) {
  const response = fetchJsonSync(`${config.domain.cloudflareApiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Cloudflare ${method} ${path} failed: ${response.status} ${response.body}`);
  }
  const parsed = response.body ? JSON.parse(response.body) : {};
  if (parsed.success === false) {
    throw new Error(`Cloudflare ${method} ${path} failed: ${response.body}`);
  }
  return parsed;
}

function resolveCloudflareApiToken(options: { required: boolean }) {
  const direct = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (direct) {
    return direct;
  }

  const vault = Bun.which("vault");
  if (vault) {
    const path = process.env.VAULT_CLOUDFLARE_API_TOKEN_PATH?.trim() || config.domain.cloudflareVaultPath;
    const field = process.env.VAULT_CLOUDFLARE_API_TOKEN_FIELD?.trim() || config.domain.cloudflareVaultField;
    const result = Bun.spawnSync(
      [vault, "kv", "get", `-mount=${process.env.VAULT_SECRET_MOUNT || "secret"}`, `-field=${field}`, path],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    if (result.success && result.stdout) {
      return decoder.decode(result.stdout).trim();
    }
  }

  if (!options.required) {
    return "";
  }
  throw new Error(
    [
      "CLOUDFLARE_API_TOKEN is required to create DNS records for the production Cloud Run domain.",
      `Set CLOUDFLARE_API_TOKEN or store it at secret/${config.domain.cloudflareVaultPath} field ${config.domain.cloudflareVaultField}.`,
    ].join(" ")
  );
}

function fetchJsonSync(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  const script = [
    "const url = process.argv[1];",
    "const init = JSON.parse(process.argv[2]);",
    "const response = await fetch(url, init);",
    "const body = await response.text();",
    "console.log(JSON.stringify({ status: response.status, body }));",
  ].join("\n");
  const result = Bun.spawnSync([process.execPath, "--eval", script, url, JSON.stringify(init)], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    const stderr = result.stderr ? decoder.decode(result.stderr).trim() : "";
    throw new Error(`Cloudflare request process failed\n${stderr}`);
  }
  return JSON.parse(decoder.decode(result.stdout).trim()) as { status: number; body: string };
}

function waitForServiceAccount(email: string) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (gcloud(["iam", "service-accounts", "describe", email, "--project", config.project.id], { allowFailure: true }).success) {
      return;
    }
    Bun.sleepSync(5_000);
  }
  throw new Error(`service account ${email} was created but is not yet readable`);
}

function isRetryableGcloudError(error: unknown) {
  if (!(error instanceof CommandError)) {
    return false;
  }
  const output = `${error.stdout}\n${error.stderr}`.toLowerCase();
  return (
    output.includes("does not exist") ||
    output.includes("not found") ||
    output.includes("permission denied") ||
    output.includes("failed_precondition") ||
    output.includes("try again") ||
    output.includes("retry")
  );
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
