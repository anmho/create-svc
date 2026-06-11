#!/usr/bin/env bun

import { confirm, intro, isCancel, log, outro, password, text } from "@clack/prompts";
import { createApiClient } from "@neondatabase/api-client";
import { Client } from "pg";
import { manualGitHubDeleteCommand } from "../../git-bootstrap";
import { deleteAuthResourceServer, ensureAuthClient, ensureAuthResourceServer, runAuthCommand, runAuthDoctor } from "../authctl";
import { stopLocalDev } from "../local-dev";
import { runParallelTasks, type ParallelTask } from "../parallel-tasks";
import { serviceConfig } from "../runtime";
import { isLocalDatabaseUrl, isMissingDatabaseError, resolveCommandPath } from "./lib";

const config = {
  serviceName: serviceConfig.service_id,
  hostname: serviceConfig.dns.hostname,
  neonDatabaseName: serviceConfig.neon.database_name,
  neonRoleName: serviceConfig.neon.role_name,
  triggerDev: {
    projectRefEnv: serviceConfig.workers?.trigger_dev?.project_ref_env || "TRIGGER_PROJECT_REF",
    accessTokenEnv: serviceConfig.workers?.trigger_dev?.access_token_env || "TRIGGER_ACCESS_TOKEN",
    secretKeyEnv: serviceConfig.workers?.trigger_dev?.secret_key_env || "TRIGGER_SECRET_KEY",
    waitlistTaskId: serviceConfig.workers?.trigger_dev?.waitlist_task_id || `${serviceConfig.service_id}-waitlist-follow-up`,
  },
  git: {
    enabled: Boolean(serviceConfig.git?.enabled),
    owner: serviceConfig.git?.owner || "anmho",
    repository: serviceConfig.git?.repository || serviceConfig.service_id,
    deleteOnDestroy: Boolean(serviceConfig.git?.delete_on_destroy),
  },
};

type DoctorStatus = "pass" | "warn" | "fail";

export async function main(argv = Bun.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(formatHelp());
    return;
  }

  if (command === "create") {
    return runMain("Create", async () => {
      await ensureTriggerDevConfig({ interactive: !rest.includes("--ci") });
      ensureAuthResourceServer();
      ensureAuthClient();
      const databaseUrl = await resolveDatabaseUrl({ preferRemote: true });
      await applyMigrationsWithRetries(databaseUrl);
      await ensureHyperdrive(databaseUrl);
      deployTriggerDevTasks();
      publishTriggerDevSecret();
      run("wrangler", ["deploy"]);
      return `Created https://${config.hostname}`;
    });
  }

  if (command === "deploy") {
    if (hasHelpFlag(rest)) {
      console.log(formatHelp());
      return;
    }
    return runMain("Deploy", async () => {
      await ensureTriggerDevConfig({ interactive: !rest.includes("--ci") });
      deployTriggerDevTasks();
      publishTriggerDevSecret();
      run("wrangler", ["deploy", ...rest]);
      return `Deployed https://${config.hostname}`;
    });
  }

  if (command === "migrate") {
    return runMain("Migrate", async () => {
      await applyMigrations(await resolveDatabaseUrl());
      return "Workers database migrations applied";
    });
  }

  if (command === "seed") {
    return runMain("Seed", () => "Seed data is not configured");
  }

  if (command === "dashboards") {
    return runMain("Dashboards", () => {
      run("gcx", ["dev", "lint", "run", "./grafana", "-o", "compact"]);
      run("gcx", ["resources", "push", "--path", "./grafana"]);
      return "Dashboards pushed";
    });
  }

  if (command === "dns") {
    return runMain("DNS", () => `Workers custom domain is configured in wrangler.toml for ${config.hostname}`);
  }

  if (command === "dev") {
    if (rest[0] !== "down") {
      throw new Error(`Unknown dev command: ${rest[0] || ""}\n\n${formatHelp()}`);
    }
    return runMain("Dev", () => stopLocalDev({ dockerCompose: true, removeVolumes: false }));
  }

  if (command === "doctor") {
    return runMain("Doctor", () => runDoctor());
  }

  if (command === "auth") {
    if (rest[0] === "token") {
      console.log(runAuthCommand(rest));
      return;
    }
    return runMain("Auth", () => runAuthCommand(rest));
  }

  if (command === "destroy") {
    return runMain("Destroy", async () => {
      await requireDestroyConfirmation(rest.includes("--force"));
      const wranglerArgs = rest.filter((arg) => arg !== "--force");
      const tasks: ParallelTask[] = [
        {
          label: "Stopping local dev resources",
          task: () => stopLocalDev({ dockerCompose: true, removeVolumes: true }),
        },
        {
          label: `Deleting auth resource server ${config.serviceName}`,
          task: () => deleteAuthResourceServer(),
        },
        {
          label: "Deleting Hyperdrive",
          task: () => deleteHyperdrive(),
        },
        {
          label: `Deleting Worker ${config.serviceName}`,
          task: () => run("wrangler", ["delete", "--name", config.serviceName, "--force", ...wranglerArgs]),
        },
        {
          label: "Deleting Neon database",
          task: () => deleteNeonDatabase(),
        },
        {
          label: "Deleting Grafana resources",
          task: () => deleteGrafanaResources(),
        },
      ];

      if (await confirmGitHubRepositoryDeletion(rest.includes("--force"))) {
        tasks.push({
          label: `Deleting GitHub repository ${config.git.owner}/${config.git.repository}`,
          task: () => deleteGitHubRepositoryIfOwned(),
        });
      }

      log.step(`Deleting ${tasks.length} resource groups in parallel`);
      await runParallelTasks(tasks, {
        onSuccess: (label) => log.step(`${label}: done`),
        onFailure: (label, error) => log.error(`${label} failed\n${error instanceof Error ? error.message : String(error)}`),
      });
      return `Destroyed ${config.serviceName}`;
    });
  }

  if (command === "sdk") {
    throw new Error("SDK commands are only available for ConnectRPC services");
  }

  throw new Error(`Unknown command: ${command}\n\n${formatHelp()}`);
}

function hasHelpFlag(args: string[]) {
  return args.includes("--help") || args.includes("-h") || args.includes("help");
}

function formatHelp() {
  return [
    "Usage:",
    "  service <command> [args]",
    "",
    "Commands:",
    "  create      Provision auth, database, Hyperdrive, and first deploy",
    "  deploy      Deploy the Worker",
    "  migrate     Apply database schema",
    "  seed        Report seed status",
    "  doctor      Check local tools and cloud access",
    "  auth        Manage auth resource server and clients",
    "  auth token  Mint a bearer token for protected API checks",
    "  dev down    Stop local dev and Docker Compose containers",
    "  dns         Show Workers custom-domain configuration",
    "  dashboards  Publish Grafana resources",
    "  destroy     Remove service-managed Worker resources",
  ].join("\n");
}

function deleteGitHubRepositoryIfOwned() {
  const repository = `${config.git.owner}/${config.git.repository}`;
  if (!config.git.deleteOnDestroy) {
    log.step(
      `Skipping GitHub repository ${repository}: ${
        config.git.enabled ? `not created by this service CLI run; manual cleanup: ${manualGitHubDeleteCommand(repository)}` : "git disabled"
      }`
    );
    return;
  }
  run("gh", ["auth", "status"], { capture: true });
  const view = run("gh", ["repo", "view", repository, "--json", "name"], { allowFailure: true, capture: true });
  if (!view.success) {
    log.step(`Skipping GitHub repository ${repository}: not found`);
    return;
  }
  run("gh", ["repo", "delete", repository, "--yes"]);
}

async function confirmGitHubRepositoryDeletion(force: boolean) {
  const repository = `${config.git.owner}/${config.git.repository}`;
  if (!config.git.deleteOnDestroy) {
    log.step(
      `Skipping GitHub repository ${repository}: ${
        config.git.enabled ? `not created by this service CLI run; manual cleanup: ${manualGitHubDeleteCommand(repository)}` : "git disabled"
      }`
    );
    return false;
  }

  if (force) {
    log.step(`Keeping GitHub repository ${repository}; delete manually with: ${manualGitHubDeleteCommand(repository)}`);
    return false;
  }

  if (!process.stdin.isTTY) {
    return false;
  }

  const deleteAnswer = await confirm({
    message: `Delete GitHub repository ${repository}?`,
    initialValue: false,
  });
  if (isCancel(deleteAnswer) || !deleteAnswer) {
    log.step(`Keeping GitHub repository ${repository}; delete manually with: ${manualGitHubDeleteCommand(repository)}`);
    return false;
  }

  const confirmAnswer = await confirm({
    message: `Confirm deleting GitHub repository ${repository}? This cannot be undone.`,
    initialValue: false,
  });
  if (isCancel(confirmAnswer) || !confirmAnswer) {
    log.step(`Keeping GitHub repository ${repository}; delete manually with: ${manualGitHubDeleteCommand(repository)}`);
    return false;
  }

  return true;
}

function run(command: string, args: string[], options: { allowFailure?: boolean; capture?: boolean; env?: Record<string, string | undefined> } = {}) {
  const resolvedCommand = resolveCommandPath(command);
  if (!resolvedCommand) {
    throw new Error(`missing required command: ${command}`);
  }
  const result = Bun.spawnSync([resolvedCommand, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdin: "inherit",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: options.capture ? "pipe" : "inherit",
  });
  if (!result.success && !options.allowFailure) {
    const output = options.capture ? commandOutput(result) : "";
    throw new Error(
      [`${command} ${args.join(" ")} failed with exit code ${result.exitCode}`, output ? `output:\n${output}` : ""]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result;
}

function commandOutput(result: Bun.SyncSubprocess<"pipe" | "inherit", "pipe" | "inherit">) {
  const stdout = result.stdout instanceof Uint8Array ? new TextDecoder().decode(result.stdout).trim() : "";
  const stderr = result.stderr instanceof Uint8Array ? new TextDecoder().decode(result.stderr).trim() : "";
  return [stdout, stderr].filter(Boolean).join("\n");
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

async function ensureHyperdrive(databaseUrl?: string) {
  const configPath = "./wrangler.toml";
  const text = await Bun.file(configPath).text();
  if (!text.includes('binding = "HYPERDRIVE"')) {
    return;
  }
  if (!text.includes('id = ""')) {
    return;
  }

  const resolvedDatabaseUrl = databaseUrl ?? (await resolveDatabaseUrl());

  const result = run("wrangler", ["hyperdrive", "create", `${config.serviceName}-hyperdrive`, "--connection-string", resolvedDatabaseUrl], {
    capture: true,
  });
  const output = `${result.stdout ? new TextDecoder().decode(result.stdout) : ""}\n${result.stderr ? new TextDecoder().decode(result.stderr) : ""}`;
  const hyperdriveId = extractHyperdriveId(output);
  if (!hyperdriveId) {
    throw new Error(`Could not find Hyperdrive id in wrangler output:\n${output.trim()}`);
  }

  await Bun.write(configPath, text.replace('id = ""', `id = "${hyperdriveId}"`));
}

function extractHyperdriveId(output: string) {
  const jsonMatch = output.match(/"id"\s*:\s*"([^"]+)"/);
  if (jsonMatch?.[1]) {
    return jsonMatch[1];
  }
  const tomlMatch = output.match(/id\s*=\s*"([^"]+)"/);
  return tomlMatch?.[1];
}

async function deleteHyperdrive() {
  const text = await Bun.file("./wrangler.toml").text();
  const id = text.match(/binding\s*=\s*"HYPERDRIVE"[\s\S]*?id\s*=\s*"([^"]+)"/)?.[1];
  if (!id) {
    return;
  }
  run("wrangler", ["hyperdrive", "delete", id], { allowFailure: true });
}

async function resolveDatabaseUrl(options: { preferRemote?: boolean } = {}) {
  const direct = Bun.env.DATABASE_URL?.trim();
  const apiKey = resolveNeonApiKey();
  if (direct) {
    if (!options.preferRemote || !isLocalDatabaseUrl(direct)) {
      return direct;
    }
    if (!apiKey) {
      throw new Error("NEON_API_KEY or readable Vault Neon provider path is required for Workers production create; ignoring local DATABASE_URL");
    }
  }

  if (!apiKey) {
    throw new Error("NEON_API_KEY, readable Vault Neon provider path, or non-local DATABASE_URL is required to provision the Hyperdrive binding");
  }

  const { neon, projectId, branchId } = await resolveNeonTarget(apiKey);

  try {
    await neon.getProjectBranchDatabase(projectId, branchId, config.neonDatabaseName);
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 404) {
      throw error;
    }
    await neon.createProjectBranchDatabase(projectId, branchId, {
      database: {
        name: config.neonDatabaseName,
        owner_name: config.neonRoleName,
      },
    });
  }

  const uriPayload = await neon.getConnectionUri({
    projectId,
    branch_id: branchId,
    database_name: config.neonDatabaseName,
    role_name: config.neonRoleName,
  });
  const uri = (uriPayload.data as { uri?: string } | undefined)?.uri;
  if (!uri) {
    throw new Error(`Neon did not return a connection URI for ${config.neonDatabaseName}`);
  }
  return uri;
}

function resolveNeonApiKey() {
  const direct = Bun.env.NEON_API_KEY?.trim();
  if (direct) {
    return direct;
  }

  const vault = resolveCommandPath("vault");
  if (!vault) {
    return "";
  }

  const mount = Bun.env.VAULT_SECRET_MOUNT?.trim() || "secret";
  const path = Bun.env.VAULT_NEON_API_KEY_PATH?.trim() || "prod/providers/neon";
  const field = Bun.env.VAULT_NEON_API_KEY_FIELD?.trim() || "api_key";
  const result = Bun.spawnSync([vault, "kv", "get", `-mount=${mount}`, `-field=${field}`, path], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success || !result.stdout) {
    return "";
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function resolveNeonTarget(apiKey: string) {
  const neon = createApiClient({ apiKey });
  const projectsPayload = await neon.listProjects({ limit: 100 });
  const projects = ((projectsPayload.data as { projects?: Array<{ id?: string }> } | undefined)?.projects ?? []).filter((project) => project.id);
  const project = projects[0];
  if (!project?.id) {
    throw new Error("No Neon projects are available for Workers provisioning");
  }

  const branchesPayload = await neon.listProjectBranches({ projectId: project.id });
  const branches = ((branchesPayload.data as { branches?: Array<{ id?: string; name?: string }> } | undefined)?.branches ?? []).filter(
    (branch) => branch.id
  );
  const branch = branches.find((candidate) => candidate.name === "main") ?? branches[0];
  if (!branch?.id) {
    throw new Error(`No Neon branches are available in project ${project.id}`);
  }

  return { neon, projectId: project.id, branchId: branch.id };
}

async function deleteNeonDatabase() {
  const apiKey = resolveNeonApiKey();
  if (!apiKey) {
    log.step("Skipping Neon database deletion because NEON_API_KEY or a readable Vault Neon provider path is not available");
    return;
  }

  const { neon, projectId, branchId } = await resolveNeonTarget(apiKey);
  try {
    await neon.getProjectBranchDatabase(projectId, branchId, config.neonDatabaseName);
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return;
    }
    throw error;
  }

  const payload = await neon.getProjectBranchDatabase(projectId, branchId, config.neonDatabaseName);
  const database = (payload.data as { database?: { name?: string; owner_name?: string } } | undefined)?.database;
  if (!database || database.name !== config.neonDatabaseName || (database.owner_name && database.owner_name !== config.neonRoleName)) {
    throw new Error(`Refusing to delete Neon database ${database?.name ?? config.neonDatabaseName}; ownership metadata does not match`);
  }

  await neon.deleteProjectBranchDatabase(projectId, branchId, config.neonDatabaseName);
}

async function deleteGrafanaResources() {
  if (!(await Bun.file("./grafana").exists())) {
    return;
  }
  if (!Bun.which("gcx")) {
    log.step("Skipping Grafana deletion because gcx is not installed");
    return;
  }
  run("gcx", ["resources", "delete", "--path", "./grafana", "--yes", "--on-error", "ignore"], { allowFailure: true });
}

async function applySchema(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
create table if not exists waitlist_entries (
  id text primary key,
  email text not null unique,
  name text,
  company text,
  source text,
  status text not null default 'joined',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists waitlist_triggers (
  id text primary key,
  type text not null,
  entry_id text references waitlist_entries(id) on delete set null,
  status text not null default 'queued',
  payload_json text not null default '{}',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists waitlist_triggers_status_created_idx
  on waitlist_triggers (status, created_at);
`);
  } finally {
    await client.end();
  }
}

async function applyMigrations(databaseUrl: string) {
  if ((serviceConfig.framework as string) === "connectrpc") {
    await waitForDatabase(databaseUrl);
    run("bun", ["run", "drizzle-kit", "migrate", "--config", "drizzle.config.ts"], {
      capture: true,
      env: {
        DATABASE_URL: databaseUrl,
      },
    });
    return;
  }

  await applySchema(databaseUrl);
}

async function waitForDatabase(databaseUrl: string, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1_000);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  throw new Error(`Timed out waiting for DATABASE_URL to accept connections: ${formatError(lastError)}`);
}

async function applyMigrationsWithRetries(databaseUrl: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await applyMigrations(databaseUrl);
      return;
    } catch (error) {
      lastError = error;
      if (!isMissingDatabaseError(error) || attempt === 10) {
        break;
      }
      await Bun.sleep(2_000);
    }
  }
  throw lastError;
}

async function runDoctor() {
  const results: Array<{ name: string; status: DoctorStatus; detail: string }> = [];

  await record(results, "bun CLI", "fail", () => checkCommand("bun"));
  await record(results, "wrangler CLI", "fail", () => checkCommand("wrangler"));
  await record(results, "wrangler auth", "fail", () => {
    run("wrangler", ["whoami"]);
    return "authenticated";
  });
  await record(results, "wrangler.toml", "fail", async () => {
    const text = await Bun.file("./wrangler.toml").text();
    if (!text.includes(`name = "${config.serviceName}"`)) {
      throw new Error(`wrangler.toml does not name ${config.serviceName}`);
    }
    if (!text.includes(`pattern = "${config.hostname}"`)) {
      throw new Error(`wrangler.toml does not route ${config.hostname}`);
    }
    return "name and custom domain route configured";
  });
  await record(results, "Hyperdrive binding", "warn", async () => {
    const text = await Bun.file("./wrangler.toml").text();
    if (!text.includes('binding = "HYPERDRIVE"')) {
      throw new Error("HYPERDRIVE binding is missing");
    }
    if (text.includes('id = ""')) {
      throw new Error("HYPERDRIVE id is not provisioned yet");
    }
    return "Hyperdrive binding has an id";
  });
  await record(results, "dashboard tooling", "warn", () => checkCommand("gcx"));
  await record(results, "dashboard artifacts", "warn", async () => {
    if (!(await Bun.file("./grafana").exists()) && !(await Bun.file("./dashboards").exists())) {
      throw new Error("no grafana/ or dashboards/ directory found");
    }
    return "dashboard directory found";
  });
  await record(results, "authctl", "warn", () => runAuthDoctor().detail);
  await record(results, "Trigger.dev config", "fail", () => {
    ensureTriggerDevConfig();
    return `${config.triggerDev.waitlistTaskId} configured`;
  });
  await record(results, "Trigger.dev CLI", "warn", () => checkCommand("trigger"));
  await record(results, "deployed health", "warn", async () => {
    const response = await fetch(`https://${config.hostname}/healthz`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      throw new Error(`GET /healthz returned ${response.status}`);
    }
    return "GET /healthz ok";
  });

  const output = results.map(formatDoctorResult).join("\n");
  const failures = results.filter((result) => result.status === "fail");
  if (failures.length > 0) {
    throw new Error(`Doctor found ${failures.length} failing check(s)\n${output}`);
  }
  return output;
}

async function ensureTriggerDevConfig(options: { interactive?: boolean } = {}) {
  const missing = [];
  if (!process.env[config.triggerDev.projectRefEnv]?.trim()) {
    missing.push(config.triggerDev.projectRefEnv);
  }
  if (!process.env[config.triggerDev.accessTokenEnv]?.trim()) {
    missing.push(config.triggerDev.accessTokenEnv);
  }
  if (!process.env[config.triggerDev.secretKeyEnv]?.trim()) {
    missing.push(config.triggerDev.secretKeyEnv);
  }
  if (missing.length > 0 && options.interactive !== false) {
    await promptForTriggerDevConfig(missing);
    missing.splice(0, missing.length);
    if (!process.env[config.triggerDev.projectRefEnv]?.trim()) {
      missing.push(config.triggerDev.projectRefEnv);
    }
    if (!process.env[config.triggerDev.accessTokenEnv]?.trim()) {
      missing.push(config.triggerDev.accessTokenEnv);
    }
    if (!process.env[config.triggerDev.secretKeyEnv]?.trim()) {
      missing.push(config.triggerDev.secretKeyEnv);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${formatList(missing)} required for Workers Trigger.dev task deployment and dispatch. Get them from the Trigger.dev console by creating/selecting a project, then provide the project ref, deploy access token, and secret key.`
    );
  }
}

async function promptForTriggerDevConfig(missing: string[]) {
  log.info(
    [
      "Workers background tasks need Trigger.dev credentials.",
      "Create/select the Trigger.dev project in the console, then paste the project ref, access token, and secret key.",
    ].join(" ")
  );

  if (missing.includes(config.triggerDev.projectRefEnv)) {
    process.env[config.triggerDev.projectRefEnv] = await promptRequiredText(
      `${config.triggerDev.projectRefEnv} (Trigger.dev project ref)`
    );
  }
  if (missing.includes(config.triggerDev.accessTokenEnv)) {
    process.env[config.triggerDev.accessTokenEnv] = await promptRequiredSecret(
      `${config.triggerDev.accessTokenEnv} (Trigger.dev deploy access token)`
    );
  }
  if (missing.includes(config.triggerDev.secretKeyEnv)) {
    process.env[config.triggerDev.secretKeyEnv] = await promptRequiredSecret(
      `${config.triggerDev.secretKeyEnv} (Trigger.dev secret key)`
    );
  }
}

async function promptRequiredText(message: string) {
  const answer = await text({
    message,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  if (isCancel(answer)) {
    throw new Error("Trigger.dev configuration cancelled");
  }
  return String(answer).trim();
}

async function promptRequiredSecret(message: string) {
  const answer = await password({
    message,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  if (isCancel(answer)) {
    throw new Error("Trigger.dev configuration cancelled");
  }
  return String(answer).trim();
}

function formatList(values: string[]) {
  if (values.length <= 1) {
    return values[0] ?? "";
  }
  if (values.length === 2) {
    return values.join(" and ");
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function deployTriggerDevTasks() {
  run("trigger", ["deploy", "--project-ref", process.env[config.triggerDev.projectRefEnv]?.trim() || ""]);
}

function publishTriggerDevSecret() {
  const secret = process.env[config.triggerDev.secretKeyEnv]?.trim();
  if (!secret) {
    throw new Error(`${config.triggerDev.secretKeyEnv} required to publish the Workers Trigger.dev secret`);
  }
  const wrangler = resolveCommandPath("wrangler");
  if (!wrangler) {
    throw new Error("missing required command: wrangler");
  }
  runShell(`printf %s "$${config.triggerDev.secretKeyEnv}" | ${shellQuote(wrangler)} secret put TRIGGER_SECRET_KEY --name ${shellQuote(config.serviceName)}`);
}

function runShell(script: string) {
  const shell = Bun.which("sh");
  if (!shell) {
    throw new Error("missing required command: sh");
  }
  const result = Bun.spawnSync([shell, "-c", script], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) {
    throw new Error(`shell command failed with exit code ${result.exitCode}: ${script}`);
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function record(
  results: Array<{ name: string; status: DoctorStatus; detail: string }>,
  name: string,
  failureStatus: "warn" | "fail",
  check: () => string | Promise<string>
) {
  try {
    results.push({ name, status: "pass", detail: await check() });
  } catch (error) {
    results.push({ name, status: failureStatus, detail: error instanceof Error ? error.message : String(error) });
  }
}

function checkCommand(name: string) {
  const path = resolveCommandPath(name);
  if (!path) {
    throw new Error(`${name} is not installed`);
  }
  return path;
}

function formatDoctorResult(result: { name: string; status: DoctorStatus; detail: string }) {
  const marker = result.status === "pass" ? "PASS" : result.status === "warn" ? "WARN" : "FAIL";
  return `[${marker}] ${result.name}: ${result.detail}`;
}

async function requireDestroyConfirmation(force: boolean) {
  if (force) {
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error("service destroy requires --force when running non-interactively");
  }

  const answer = await confirm({
    message: `Destroy resources owned by ${config.serviceName}?`,
    initialValue: false,
  });
  if (isCancel(answer) || !answer) {
    throw new Error("Destroy cancelled");
  }
}

async function runMain(name: string, task: () => string | Promise<string>) {
  intro(name);
  try {
    outro(await task());
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
