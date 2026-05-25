#!/usr/bin/env bun

import { mkdir, readdir, stat } from "node:fs/promises";
import { ensureAuthClient, ensureAuthResourceServer, runAuthCommand, runAuthDoctor } from "../authctl";
import { stopLocalDev } from "../local-dev";
import { bootstrap, prepareGcpProject } from "./bootstrap";
import { cleanup } from "./cleanup";
import { deploy } from "./deploy";
import { observabilityBootstrap } from "./observability";
import { config } from "./config";
import { formatSdkModeDetail, type SdkState } from "./sdk-state";
import {
  accessSecretVersion,
  assertProductionDomainAvailable,
  assertServiceNameAvailable,
  describeProductionDomainMapping,
  formatError,
  gcloud,
  ensureProductionDomainMapping,
  readVaultField,
  requireCommand,
  requireGcloudAuth,
  resolveDeploymentTarget,
  run,
  runMain,
  runStep,
  serviceOrigin,
} from "./lib";

export async function main(argv = Bun.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(formatHelp());
    return;
  }

  if (command === "create") {
    await runMain("Create", async () => {
      assertServiceNameAvailable(config.serviceName);
      assertProductionDomainAvailable(config.serviceName);
      await prepareGcpProject();
      await runStep("Registering auth resource server", () => ensureAuthResourceServer());
      await runStep("Provisioning auth client", () => ensureAuthClient());
      const bootstrapResult = await bootstrap({ skipProjectSetup: true });
      const databaseUrl = bootstrapResult.databaseUrl;
      const origin = await deploy(["--ci"], { bootstrapResult });
      await runOptionalBunScript("seed", { DATABASE_URL: databaseUrl });
      return `Created ${origin}`;
    });
    return;
  }

  if (command === "deploy") {
    if (hasHelpFlag(rest)) {
      console.log(formatHelp());
      return;
    }
    await runMain("Deploy", () => deploy(rest));
    return;
  }

  if (command === "migrate") {
    await runMain("Migrate", () => runLanguageTask("migrate"));
    return;
  }

  if (command === "seed") {
    await runMain("Seed", () => runOptionalBunScript("seed"));
    return;
  }

  if (command === "dashboards") {
    await runMain("Dashboards", () => runDashboards());
    return;
  }

  if (command === "observability-bootstrap") {
    await runMain("Google observability bootstrap", async () => {
      await observabilityBootstrap();
      return `Google observability bootstrap finished for ${config.serviceName}`;
    });
    return;
  }

  if (command === "dev") {
    if (rest[0] !== "down") {
      throw new Error(`Unknown dev command: ${rest[0] || ""}\n\n${formatHelp()}`);
    }
    await runMain("Dev", () => stopLocalDev({ dockerCompose: true, removeVolumes: false }));
    return;
  }

  if (command === "dns") {
    await runMain("DNS", () => repairDns());
    return;
  }

  if (command === "doctor") {
    await runMain("Doctor", () => runDoctor());
    return;
  }

  if (command === "auth") {
    if (rest[0] === "token") {
      console.log(runAuthCommand(rest));
      return;
    }
    await runMain("Auth", () => runAuthCommand(rest));
    return;
  }

  if (command === "destroy") {
    await runMain("Destroy", () => cleanup(rest));
    return;
  }

  if (command === "sdk") {
    await runMain("SDK", () => runSdk(rest));
    return;
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
    "  create      Provision auth, database, migrations, and first deploy",
    "  deploy      Deploy the current service",
    "  migrate     Apply database migrations",
    "  seed        Run the seed script when configured",
    "  doctor      Check local tools and cloud access",
    "  auth        Manage auth resource server and clients",
    "  auth token  Mint a bearer token for protected API checks",
    "  sdk         Build or publish generated SDK artifacts",
    "  dns         Repair or inspect DNS mappings",
    "  dev down    Stop local dev and Docker Compose containers",
    "  observability-bootstrap  Enable Google observability APIs",
    "  dashboards  Publish Grafana resources",
    "  destroy     Remove service-managed cloud resources",
  ].join("\n");
}

function runLanguageTask(task: "migrate", env?: Record<string, string | undefined>) {
  if (config.runtime === "bun") {
    run("bun", ["run", `./scripts/${task}.ts`], { env });
    return `${task} finished`;
  }

  if (task === "migrate") {
    if (env?.DATABASE_URL) {
      run("atlas", ["migrate", "apply", "--env", "local"], { env });
    } else {
      run("make", ["migrate"], { env });
    }
    return `${task} finished`;
  }

  throw new Error(`${task} is not available for ${config.runtime}`);
}

async function runOptionalBunScript(name: string, env?: Record<string, string | undefined>) {
  const scriptPath = `./scripts/${name}.ts`;
  if (!(await Bun.file(scriptPath).exists())) {
    return `${name} script is not configured`;
  }

  run("bun", ["run", scriptPath], { env });
  return `${name} finished`;
}

function runDashboards() {
  requireCommand("gcx");
  run("gcx", ["dev", "lint", "run", "./grafana", "-o", "compact"]);
  run("gcx", ["resources", "push", "--path", "./grafana"]);
  return "Dashboards pushed";
}

function repairDns() {
  ensureProductionDomainMapping(config.serviceName);
  return `DNS mapping ready for https://${config.domain.hostname}`;
}

async function runDoctor() {
  const results: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
  const target = resolveDeploymentTarget("main");

  await record(results, "bun CLI", "fail", () => checkCommand("bun"));
  await record(results, "gcloud CLI", "fail", () => checkCommand("gcloud"));
  await record(results, "gcloud auth", "fail", () => {
    requireGcloudAuth();
    return "active account available";
  });
  await record(results, "GCP project", "fail", () => {
    gcloud(["projects", "describe", config.project.id, "--format=value(projectId)"]);
    return config.project.id;
  });
  await record(results, "Cloud Run service", "fail", () => {
    const serviceName = gcloud([
      "run",
      "services",
      "describe",
      target.serviceName,
      "--project",
      config.project.id,
      "--region",
      config.region,
      "--format=value(metadata.name)",
    ]).stdout;
    return serviceName || target.serviceName;
  });
  await record(results, "runtime database secret", "fail", () => {
    const value = accessSecretVersion(target.databaseSecretName);
    if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
      throw new Error(`${target.databaseSecretName} does not look like a Postgres URL`);
    }
    return target.databaseSecretName;
  });
  await record(results, "DNS mapping", "fail", () => {
    const mapping = describeProductionDomainMapping();
    const mappedService = mapping?.spec?.routeName;
    if (mappedService !== target.serviceName) {
      throw new Error(`${config.domain.hostname} maps to ${mappedService || "nothing"}, expected ${target.serviceName}`);
    }
    return `${config.domain.hostname} -> ${target.serviceName}`;
  });
  await record(results, "deployment health", "fail", async () => {
    const response = await fetchWithTimeout(`${serviceOrigin(target)}/readyz`, 5_000);
    if (!response.ok) {
      throw new Error(`GET /readyz returned ${response.status}`);
    }
    return "GET /readyz ok";
  });
  await record(results, "migration assets", "fail", async () => {
    if (!(await Bun.file("./migrations/0000_init.sql").exists())) {
      throw new Error("missing migrations/0000_init.sql");
    }
    return "migrations/0000_init.sql";
  });
  if ((config.runtime as string) === "go") {
    await record(results, "Atlas CLI", "fail", () => checkCommand("atlas"));
    await record(results, "Atlas config", "fail", async () => {
      if (!(await Bun.file("./atlas.hcl").exists())) {
        throw new Error("missing atlas.hcl");
      }
      return "atlas.hcl";
    });
  }
  await record(results, "dashboard tooling", "warn", () => {
    if (!Bun.which("gcx")) {
      throw new Error("gcx is not installed");
    }
    return "gcx available";
  });
  await record(results, "dashboard artifacts", "warn", async () => {
    if (!(await directoryExists("./grafana")) && !(await directoryExists("./dashboards"))) {
      throw new Error("no grafana/ or dashboards/ directory found");
    }
    return "dashboard directory found";
  });
  await record(results, "authctl", "warn", () => runAuthDoctor().detail);
  await record(results, "Temporal/Cron", "warn", async () => {
    const hasBunTemporal = await Bun.file("./src/temporal/worker.ts").exists();
    const hasGoTemporal = await Bun.file("./internal/temporal/worker.go").exists();
    if (!hasBunTemporal && !hasGoTemporal) {
      throw new Error("Temporal worker config is not present in this scaffold yet");
    }
    return "Temporal worker config present";
  });

  if ((config.framework as string) === "connectrpc") {
    await record(results, "ConnectRPC proto", "fail", async () => {
      if (!(await Bun.file("./buf.yaml").exists())) {
        throw new Error("missing buf.yaml");
      }
      const protoFiles = await findFiles("./protos", ".proto");
      if (protoFiles.length === 0) {
        throw new Error("missing ConnectRPC proto");
      }
      return `${protoFiles.length} proto file(s) present`;
    });
    await record(results, "Buf CLI", "warn", () => checkCommand("buf"));
    await record(results, "generated SDK artifacts", "warn", async () => {
      const artifacts = await findGeneratedSdkArtifacts();
      if (artifacts.length === 0) {
        throw new Error("generated SDK artifacts are missing; run service sdk build");
      }
      return "local generated artifacts present";
    });
    await record(results, "SDK mode", "warn", async () => {
      const text = await Bun.file(".service/sdk.json").text();
      const state = JSON.parse(text) as SdkState;
      return formatSdkModeDetail(state, bufModule());
    });
  }

  const output = results.map(formatDoctorResult).join("\n");
  const failures = results.filter((result) => result.status === "fail");
  if (failures.length > 0) {
    throw new Error(`Doctor found ${failures.length} failing check(s)\n${output}`);
  }
  return output;
}

async function record(
  results: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }>,
  name: string,
  failureStatus: "warn" | "fail",
  check: () => string | Promise<string>
) {
  try {
    results.push({ name, status: "pass", detail: await check() });
  } catch (error) {
    results.push({ name, status: failureStatus, detail: formatError(error) });
  }
}

function checkCommand(name: string) {
  const path = Bun.which(name);
  if (!path) {
    throw new Error(`${name} is not installed`);
  }
  return path;
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

function formatDoctorResult(result: { name: string; status: "pass" | "warn" | "fail"; detail: string }) {
  const marker = result.status === "pass" ? "PASS" : result.status === "warn" ? "WARN" : "FAIL";
  return `[${marker}] ${result.name}: ${result.detail}`;
}

async function runSdk(args: string[]) {
  if ((config.framework as string) !== "connectrpc") {
    throw new Error("SDK commands are only available for ConnectRPC services");
  }

  const [subcommand] = args;
  if (subcommand === "publish") {
    requireCommand("buf");
    const authEnv = resolveBufAuthEnv();
    run("buf", ["push", "--create", "--create-visibility", "private"], { env: authEnv });
    const published = resolvePublishedSdk(authEnv);
    await writeSdkMode("remote", published);
    return `Schema pushed to Buf Schema Registry and recorded for consumers: ${published.commit}`;
  }

  if (subcommand === "build") {
    if (config.runtime === "bun") {
      run("bun", ["run", "gen"]);
    } else {
      run("make", ["gen"]);
    }
    await writeSdkMode("local");
    return "Local SDK artifacts generated and recorded";
  }

  if (subcommand === "use-local") {
    await assertLocalSdkArtifacts();
    await writeSdkMode("local");
    return "Local SDK artifacts recorded";
  }

  if (subcommand === "use-remote") {
    requireCommand("buf");
    const authEnv = resolveBufAuthEnv();
    const published = resolvePublishedSdk(authEnv);
    await writeSdkMode("remote", published);
    return `Remote Buf SDK recorded for consumers: ${bufModule()}@${published.commit}`;
  }

  throw new Error("Usage: service sdk <build|publish|use-local|use-remote>");
}

async function assertLocalSdkArtifacts() {
  const artifacts = await findGeneratedSdkArtifacts();
  if (artifacts.length === 0) {
    throw new Error("Local SDK artifacts are missing. Run `service sdk build` first.");
  }
}

type PublishedSdk = {
  commit: string;
  digest?: string;
  createTime?: string;
};

function resolvePublishedSdk(authEnv: Record<string, string> = {}): PublishedSdk {
  const module = bufModule();
  const result = run("buf", ["registry", "module", "commit", "list", module, "--format", "json", "--page-size", "1"], { env: authEnv });
  const parsed = JSON.parse(result.stdout) as {
    commits?: Array<Record<string, unknown>>;
    commit?: Record<string, unknown>;
  };
  const commit = parsed.commits?.[0] ?? parsed.commit;
  if (!commit) {
    throw new Error(`Could not resolve the published Buf commit for ${module}`);
  }
  const name = stringField(commit, "name") ?? stringField(commit, "commit") ?? stringField(commit, "id");
  if (!name) {
    throw new Error(`Buf commit response for ${module} did not include a commit identifier`);
  }
  return {
    commit: name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name,
    digest: stringField(commit, "digest"),
    createTime: stringField(commit, "create_time") ?? stringField(commit, "createTime"),
  };
}

function stringField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function writeSdkMode(mode: "local" | "remote", published?: PublishedSdk) {
  await mkdir(".service", { recursive: true });
  const localPath = await resolveLocalSdkPath();
  await Bun.write(
    ".service/sdk.json",
    `${JSON.stringify(
      {
        mode,
        module: bufModule(),
        localPath,
        ...(published
          ? {
              remote: {
                commit: published.commit,
                digest: published.digest,
                createTime: published.createTime,
              },
            }
          : {}),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
}

function bufModule() {
  return config.buf.module || `buf.build/anmho/${config.serviceName}`;
}

function resolveBufAuthEnv(): Record<string, string> {
  const token =
    process.env.BUF_TOKEN?.trim() ||
    readVaultField(config.buf.vaultMount, config.buf.vaultPath, ["BUF_TOKEN", "buf.api_token", "buf_token", "api_token", "token"]);
  if (!token) {
    return {};
  }
  return { BUF_TOKEN: token };
}

async function resolveLocalSdkPath() {
  const artifacts = await findGeneratedSdkArtifacts();
  if (artifacts.length === 0) {
    return config.runtime === "bun" ? "./gen/protos" : "./gen";
  }
  const artifact = artifacts[0] || "./gen";
  return artifact.split("/").slice(0, -1).join("/") || "./gen";
}

async function findGeneratedSdkArtifacts() {
  const suffixes = config.runtime === "bun" ? ["_pb.ts", "_pb.js"] : [".pb.go"];
  const files = await findFiles("./gen");
  return files.filter((file) => suffixes.some((suffix) => file.endsWith(suffix)));
}

async function findFiles(root: string, suffix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await findFiles(path, suffix)));
    } else if (!suffix || path.endsWith(suffix)) {
      files.push(path);
    }
  }
  return files;
}

async function directoryExists(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  await main();
}
