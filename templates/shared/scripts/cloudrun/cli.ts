#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { ensureAuthClient, ensureAuthResourceServer, runAuthCommand, runAuthDoctor } from "../authctl";
import { bootstrap, prepareGcpProject } from "./bootstrap";
import { cleanup } from "./cleanup";
import { deploy } from "./deploy";
import { config } from "./config";
import {
  accessSecretVersion,
  assertProductionDomainAvailable,
  assertServiceNameAvailable,
  describeProductionDomainMapping,
  formatError,
  gcloud,
  ensureProductionDomainMapping,
  requireCommand,
  requireGcloudAuth,
  resolveDeploymentTarget,
  run,
  runMain,
  runStep,
  serviceOrigin,
} from "./lib";

async function main(argv = Bun.argv.slice(2)) {
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
      await bootstrap({ skipProjectSetup: true });
      const target = resolveDeploymentTarget("main");
      const databaseUrl = await runStep("Reading production database URL", () => accessSecretVersion(target.databaseSecretName));
      await runStep("Applying production migrations", () => runLanguageTask("migrate", { DATABASE_URL: databaseUrl }));
      const origin = await deploy(["--ci"]);
      await runOptionalBunScript("seed", { DATABASE_URL: databaseUrl });
      return `Created ${origin}`;
    });
    return;
  }

  if (command === "deploy") {
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
    run("make", ["migrate"], { env });
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
    const response = await fetchWithTimeout(`${serviceOrigin(target)}/healthz`, 5_000);
    if (!response.ok) {
      throw new Error(`GET /healthz returned ${response.status}`);
    }
    return "GET /healthz ok";
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
    if (!(await Bun.file("./grafana").exists()) && !(await Bun.file("./dashboards").exists())) {
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
      if (!(await Bun.file("./protos/waitlist/v1/waitlist.proto").exists())) {
        throw new Error("missing waitlist proto");
      }
      return "waitlist proto present";
    });
    await record(results, "Buf CLI", "warn", () => checkCommand("buf"));
    await record(results, "generated SDK artifacts", "warn", async () => {
      const bunGen = await Bun.file("./gen/protos/waitlist/v1/waitlist_pb.ts").exists();
      const goGen = await Bun.file("./gen/waitlist/v1/waitlist.pb.go").exists();
      if (!bunGen && !goGen) {
        throw new Error("generated SDK artifacts are missing; run service sdk build");
      }
      return "local generated artifacts present";
    });
    await record(results, "SDK mode", "warn", async () => {
      const text = await Bun.file(".service/sdk.json").text();
      const state = JSON.parse(text) as { mode?: string; module?: string };
      if (state.mode !== "local" && state.mode !== "remote") {
        throw new Error("SDK mode must be local or remote");
      }
      return `${state.mode}: ${state.module || bufModule()}`;
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
    run("buf", ["push"]);
    return "Schema pushed to Buf Schema Registry";
  }

  if (subcommand === "build") {
    if (config.runtime === "bun") {
      run("bun", ["run", "gen"]);
    } else {
      run("make", ["gen"]);
    }
    await writeSdkMode("local");
    return "Local SDK artifacts generated and selected";
  }

  if (subcommand === "use-local") {
    await assertLocalSdkArtifacts();
    await writeSdkMode("local");
    return "Local SDK artifacts selected";
  }

  if (subcommand === "use-remote") {
    await writeSdkMode("remote");
    return `Remote Buf SDK selected: ${bufModule()}`;
  }

  throw new Error("Usage: service sdk <build|publish|use-local|use-remote>");
}

async function assertLocalSdkArtifacts() {
  const bunArtifacts = await Bun.file("./gen/protos/waitlist/v1/waitlist_pb.ts").exists();
  const goArtifacts = await Bun.file("./gen/waitlist/v1/waitlist.pb.go").exists();
  if (!bunArtifacts && !goArtifacts) {
    throw new Error("Local SDK artifacts are missing. Run `service sdk build` first.");
  }
}

async function writeSdkMode(mode: "local" | "remote") {
  await mkdir(".service", { recursive: true });
  const localPath = config.runtime === "bun" ? "./gen/protos/waitlist/v1" : "./gen/waitlist/v1";
  await Bun.write(
    ".service/sdk.json",
    `${JSON.stringify(
      {
        mode,
        module: bufModule(),
        localPath,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
}

function bufModule() {
  return `buf.build/anmho/${config.serviceName}`;
}

if (import.meta.main) {
  await main();
}
