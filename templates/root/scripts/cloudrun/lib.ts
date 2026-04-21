import { config, manifestEnv } from "./config";

type CommandOptions = {
  allowFailure?: boolean;
  capture?: boolean;
  input?: string;
};

const decoder = new TextDecoder();

export function requireCommand(name: string) {
  if (!Bun.which(name)) {
    throw new Error(`missing required command: ${name}`);
  }
}

export function run(command: string, args: string[], options: CommandOptions = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: options.input,
    stdout: options.capture || options.allowFailure ? "pipe" : "inherit",
    stderr: options.capture || options.allowFailure ? "pipe" : "inherit",
  });

  const stdout = result.stdout ? decoder.decode(result.stdout).trim() : "";
  const stderr = result.stderr ? decoder.decode(result.stderr).trim() : "";

  if (!result.success && !options.allowFailure) {
    throw new Error([`command failed: ${command} ${args.join(" ")}`, stdout, stderr].filter(Boolean).join("\n"));
  }

  return {
    success: result.success,
    stdout,
    stderr,
    exitCode: result.exitCode,
  };
}

export function gcloud(args: string[], options: CommandOptions = {}) {
  return run("gcloud", args, options);
}

export function gh(args: string[], options: CommandOptions = {}) {
  return run("gh", args, options);
}

export function ensureServiceAccount(email: string) {
  if (gcloud(["iam", "service-accounts", "describe", email, "--project", config.projectId], { allowFailure: true }).success) {
    return;
  }

  const accountId = email.split("@")[0] ?? email;
  gcloud(["iam", "service-accounts", "create", accountId, "--project", config.projectId, "--display-name", accountId]);
}

export function ensureProjectRole(member: string, role: string) {
  gcloud(["projects", "add-iam-policy-binding", config.projectId, "--member", member, "--role", role]);
}

export function ensureServiceAccountRole(serviceAccount: string, member: string, role: string) {
  gcloud([
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    serviceAccount,
    "--project",
    config.projectId,
    "--member",
    member,
    "--role",
    role,
  ]);
}

export function ensureSecret(secretName: string, bootstrapEnv: string) {
  if (gcloud(["secrets", "describe", secretName, "--project", config.projectId], { allowFailure: true }).success) {
    return;
  }

  const value = process.env[bootstrapEnv]?.trim() ?? "";
  if (!value) {
    throw new Error(`missing bootstrap value for secret ${secretName}; set ${bootstrapEnv}`);
  }

  gcloud(["secrets", "create", secretName, "--project", config.projectId, "--replication-policy", "automatic"]);
  gcloud(["secrets", "versions", "add", secretName, "--project", config.projectId, "--data-file=-"], { input: value });
}

export function ensureSecretAccessor(secretName: string, member: string) {
  gcloud(["secrets", "add-iam-policy-binding", secretName, "--project", config.projectId, "--member", member, "--role", "roles/secretmanager.secretAccessor"]);
}

export function projectNumber() {
  return gcloud(["projects", "describe", config.projectId, "--format=value(projectNumber)"], { capture: true }).stdout;
}

export function workloadIdentityPoolResource() {
  return `projects/${projectNumber()}/locations/global/workloadIdentityPools/${config.workloadIdentityPoolId}`;
}

export function workloadIdentityProviderResource() {
  return `${workloadIdentityPoolResource()}/providers/${config.workloadIdentityProviderId}`;
}

export function ensureWorkloadIdentityPool() {
  if (
    gcloud(["iam", "workload-identity-pools", "describe", config.workloadIdentityPoolId, "--project", config.projectId, "--location", "global"], {
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
    config.projectId,
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
        config.projectId,
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
    config.projectId,
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
    `assertion.repository=='${config.githubRepo}'`,
  ]);
}

export function setGithubVariable(name: string, value: string) {
  gh(["variable", "set", name, "--repo", config.githubRepo, "--body", value]);
}

export function setGithubSecret(name: string, value: string) {
  gh(["secret", "set", name, "--repo", config.githubRepo], { input: value });
}

export function ensureArtifactRepository() {
  if (
    gcloud(
      ["artifacts", "repositories", "describe", config.artifactRepository, "--project", config.projectId, "--location", config.region],
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
    config.projectId,
    "--location",
    config.region,
    "--repository-format",
    "docker",
  ]);
}

export function imageTag() {
  const gitSha = run("git", ["rev-parse", "--short", "HEAD"], { allowFailure: true, capture: true }).stdout;
  return gitSha || `${Date.now()}`;
}

export function imageUrl(tag = imageTag()) {
  return `${config.region}-docker.pkg.dev/${config.projectId}/${config.artifactRepository}/${config.serviceName}:${tag}`;
}

export async function renderManifest(image: string) {
  const template = await Bun.file(new URL("../../service.yaml", import.meta.url)).text();
  const values = {
    ...manifestEnv,
    IMAGE_URL: image,
  };

  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
    const value = values[key as keyof typeof values];
    if (!value) {
      throw new Error(`missing manifest value for ${key}`);
    }
    return value;
  });
}

export async function writeRenderedManifest(image: string) {
  const rendered = await renderManifest(image);
  const path = new URL("../../.cloudrun.rendered.yaml", import.meta.url);
  await Bun.write(path, rendered);
  return path;
}

export function serviceUrl() {
  return gcloud(
    ["run", "services", "describe", config.serviceName, "--project", config.projectId, "--region", config.region, "--format=value(status.url)"],
    { capture: true }
  ).stdout;
}
