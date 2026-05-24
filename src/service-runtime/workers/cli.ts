#!/usr/bin/env bun

import { confirm, intro, isCancel, log, outro } from "@clack/prompts";
import { createApiClient } from "@neondatabase/api-client";
import { Client } from "pg";
import { manualGitHubDeleteCommand } from "../../git-bootstrap";
import { ensureAuthClient, ensureAuthResourceServer, runAuthCommand, runAuthDoctor } from "../authctl";
import { stopLocalDev } from "../local-dev";
import { serviceConfig } from "../runtime";

const config = {
  serviceName: serviceConfig.service_id,
  hostname: serviceConfig.dns.hostname,
  neonDatabaseName: serviceConfig.neon.database_name,
  neonRoleName: serviceConfig.neon.role_name,
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
      ensureAuthResourceServer();
      ensureAuthClient();
      const databaseUrl = await resolveDatabaseUrl();
      await applySchema(databaseUrl);
      await ensureHyperdrive(databaseUrl);
      run("wrangler", ["deploy"]);
      return `Created https://${config.hostname}`;
    });
  }

  if (command === "deploy") {
    return runMain("Deploy", () => {
      run("wrangler", ["deploy", ...rest]);
      return `Deployed https://${config.hostname}`;
    });
  }

  if (command === "migrate") {
    return runMain("Migrate", async () => {
      await applySchema(await resolveDatabaseUrl());
      return "Workers database schema applied";
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
    return runMain("Dev", () => stopLocalDev({ dockerCompose: false }));
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
      await stopLocalDev({ dockerCompose: false });
      deleteGitHubRepositoryIfOwned();
      await deleteHyperdrive();
      run("wrangler", ["delete", "--name", config.serviceName, "--force", ...wranglerArgs]);
      await deleteNeonDatabase();
      await deleteGrafanaResources();
      return `Destroyed ${config.serviceName}`;
    });
  }

  if (command === "sdk") {
    throw new Error("SDK commands are only available for ConnectRPC services");
  }

  throw new Error(`Unknown command: ${command}\n\n${formatHelp()}`);
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
    "  dev down    Stop local dev",
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

function run(command: string, args: string[], options: { allowFailure?: boolean; capture?: boolean } = {}) {
  if (!Bun.which(command)) {
    throw new Error(`missing required command: ${command}`);
  }
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: options.capture ? "pipe" : "inherit",
  });
  if (!result.success && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.exitCode}`);
  }
  return result;
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
  run("wrangler", ["hyperdrive", "delete", id, "--force"], { allowFailure: true });
}

async function resolveDatabaseUrl() {
  const direct = Bun.env.DATABASE_URL?.trim();
  if (direct) {
    return direct;
  }

  const apiKey = Bun.env.NEON_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("DATABASE_URL or NEON_API_KEY is required to provision the Hyperdrive binding");
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
  const apiKey = Bun.env.NEON_API_KEY?.trim();
  if (!apiKey) {
    log.step("Skipping Neon database deletion because NEON_API_KEY is not set");
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
    if (!text.includes(`pattern = "${config.hostname}/*"`)) {
      throw new Error(`wrangler.toml does not route ${config.hostname}`);
    }
    return "name and custom domain route configured";
  });
  await record(results, "Cron Trigger", "fail", async () => {
    const text = await Bun.file("./wrangler.toml").text();
    if (!text.includes("[triggers]") || !text.includes("crons")) {
      throw new Error("wrangler.toml is missing a cron trigger");
    }
    return "cron trigger configured";
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
  const path = Bun.which(name);
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
