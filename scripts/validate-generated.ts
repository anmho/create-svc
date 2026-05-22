import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createServer } from "node:net";
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { deriveDefaults, type DeployTarget, type Framework, type GcpProjectMode, type Runtime } from "../src/naming";
import type { Profile } from "../src/profiles";
import { scaffoldProject, type ScaffoldConfig } from "../src/scaffold";

export const GENERATED_VARIANTS = [
  "bun-hono",
  "bun-connectrpc",
  "go-chi",
  "go-connectrpc",
] as const;

export type GeneratedVariant = (typeof GENERATED_VARIANTS)[number];
export type GeneratedTarget = GeneratedVariant;

type VariantDefinition = {
  name: GeneratedVariant;
  runtime: Runtime;
  framework: Framework;
  commandSteps: ValidationCommandStep[];
  smokeChecks: SmokeCheck[];
};

export type ValidationCommandStep = {
  name: string;
  command: string[];
};

export type SmokeCheck = {
  name: string;
  kind?: "http" | "connect-client" | "hono-rpc-client" | "web" | "ios-expo";
  path?: string;
  expectStatus?: number;
  protocol?: "http1" | "http2";
};

export type ValidationPlanItem = {
  name: GeneratedTarget;
  profile: Profile;
  target: DeployTarget;
  runtime: Runtime;
  framework: Framework;
  serviceName: string;
  directoryName: string;
  composeProjectName: string;
  commandSteps: ValidationCommandStep[];
  smokeChecks: SmokeCheck[];
};

export type ValidationOptions = {
  selectedVariant?: GeneratedVariant;
  selectedProfile: Profile;
  keep: boolean;
  runId?: string;
};

type RunCommandOptions = {
  cwd: string;
  env?: Record<string, string>;
};

type ServerProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

const VARIANT_DEFINITIONS: Record<GeneratedVariant, VariantDefinition> = {
  "bun-hono": {
    name: "bun-hono",
    runtime: "bun",
    framework: "hono",
    commandSteps: [
      { name: "install dependencies", command: ["bun", "install"] },
      { name: "start local postgres", command: ["docker", "compose", "up", "-d"] },
      { name: "run migrations", command: ["bun", "run", "migrate"] },
      { name: "run tests", command: ["bun", "run", "test"] },
      { name: "run lint", command: ["bun", "run", "lint"] },
    ],
    smokeChecks: [{ name: "health endpoint", path: "/healthz" }],
  },
  "bun-connectrpc": {
    name: "bun-connectrpc",
    runtime: "bun",
    framework: "connectrpc",
    commandSteps: [
      { name: "install dependencies", command: ["bun", "install"] },
      { name: "generate code", command: ["bun", "run", "gen"] },
      { name: "start local postgres", command: ["docker", "compose", "up", "-d"] },
      { name: "run migrations", command: ["bun", "run", "migrate"] },
      { name: "run tests", command: ["bun", "run", "test"] },
      { name: "run lint", command: ["bun", "run", "lint"] },
    ],
    smokeChecks: [
      { name: "health endpoint", path: "/healthz", protocol: "http2" },
      { name: "typed connect client", kind: "connect-client" },
      { name: "connectrpc introspection", path: "/debug/connectrpc", protocol: "http2" },
    ],
  },
  "go-chi": {
    name: "go-chi",
    runtime: "go",
    framework: "chi",
    commandSteps: [
      { name: "install package tooling", command: ["bun", "install"] },
      { name: "start local postgres", command: ["docker", "compose", "up", "-d"] },
      { name: "run migrations", command: ["make", "migrate"] },
      { name: "run tests", command: ["make", "test"] },
    ],
    smokeChecks: [{ name: "health endpoint", path: "/healthz" }],
  },
  "go-connectrpc": {
    name: "go-connectrpc",
    runtime: "go",
    framework: "connectrpc",
    commandSteps: [
      { name: "install package tooling", command: ["bun", "install"] },
      { name: "generate code", command: ["make", "gen"] },
      { name: "start local postgres", command: ["docker", "compose", "up", "-d"] },
      { name: "run migrations", command: ["make", "migrate"] },
      { name: "run tests", command: ["make", "test"] },
    ],
    smokeChecks: [
      { name: "health endpoint", path: "/healthz" },
      { name: "typed grpc client", kind: "connect-client" },
    ],
  },
};

const SMOKE_REQUEST_TIMEOUT_MS = 2_000;

export function parseValidationArgs(args: string[]): ValidationOptions {
  let selectedVariant: GeneratedVariant | undefined;
  let selectedProfile: Profile = "microservice";
  let keep = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }

    if (token === "--keep") {
      keep = true;
      continue;
    }

    if (token === "--variant") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --variant");
      }
      selectedVariant = parseGeneratedVariant(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--variant=")) {
      selectedVariant = parseGeneratedVariant(token.slice("--variant=".length));
      continue;
    }

    if (token === "--profile") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --profile");
      }
      selectedProfile = parseGeneratedProfile(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--profile=")) {
      selectedProfile = parseGeneratedProfile(token.slice("--profile=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return { selectedVariant, selectedProfile, keep };
}

export function planValidation(args: string[] | ValidationOptions): ValidationPlanItem[] {
  const options = Array.isArray(args) ? parseValidationArgs(args) : args;
  const variants = options.selectedVariant ? [options.selectedVariant] : GENERATED_VARIANTS;
  const runSuffix = options.runId ? `-${options.runId}` : "";
  const composeRunId = options.runId ?? "validation";

  return variants.map((name) => {
    const definition = VARIANT_DEFINITIONS[name];
    const serviceName = `validation${runSuffix}-${name}`;
    return {
      name,
      profile: "microservice",
      target: "cloudrun",
      runtime: definition.runtime,
      framework: definition.framework,
      serviceName,
      directoryName: name,
      composeProjectName: `create_svc_${composeRunId}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
      commandSteps: definition.commandSteps,
      smokeChecks: definition.smokeChecks,
    };
  });
}

export async function validateGeneratedApps(args: string[] = Bun.argv.slice(2)) {
  const options = parseValidationArgs(args);
  const generatorRoot = resolve(import.meta.dir, "..");
  const validationRoot = join(generatorRoot, "bin", "generated");
  await mkdir(validationRoot, { recursive: true });
  const root = await mkdtemp(join(validationRoot, "run-"));
  const runId = basename(root).replace(/^run-/, "").toLowerCase();
  const plan = planValidation({ ...options, runId });
  const failures: Array<{ name: GeneratedVariant; generatedRoot: string; error: unknown }> = [];

  console.log(`generated validation workspace: ${root}`);

  try {
    for (const item of plan) {
      const generatedRoot = join(root, item.directoryName);
      const startedCompose = { value: false };

      try {
        console.log(`→ ${item.name}: scaffold`);
        await scaffoldProject(createScaffoldConfig(item, generatedRoot, generatorRoot));

        for (const step of item.commandSteps) {
          console.log(`→ ${item.name}: ${step.name}`);
          if (isDockerComposeUp(step)) {
            startedCompose.value = true;
          }
          await runCommand(step.command, { cwd: generatedRoot, env: commandEnv(item, step) });
        }

        for (const smoke of item.smokeChecks) {
          console.log(`→ ${item.name}: ${smoke.name}`);
          await runSmokeCheck(item, generatedRoot, smoke);
        }

        console.log(`✓ ${item.name}`);
      } catch (error) {
        console.error(`✗ ${item.name}: ${formatError(error)}`);
        console.error(`generated workspace: ${generatedRoot}`);
        failures.push({ name: item.name, generatedRoot, error });
      } finally {
        if (startedCompose.value && !options.keep) {
          await stopDockerCompose(generatedRoot, item);
        }
      }
    }
  } finally {
    if (!options.keep) {
      await rm(root, { recursive: true, force: true });
    } else {
      console.log(`kept generated validation workspace: ${root}`);
    }
  }

  if (failures.length > 0) {
    console.error("generated validation failed:");
    for (const failure of failures) {
      console.error(`- ${failure.name}: ${formatError(failure.error)}`);
      console.error(`  workspace: ${failure.generatedRoot}`);
    }
    process.exitCode = 1;
  }
}

function parseGeneratedVariant(value: string): GeneratedVariant {
  if (!GENERATED_VARIANTS.includes(value as GeneratedVariant)) {
    throw new Error(`Unknown generated service variant: ${value}`);
  }
  return value as GeneratedVariant;
}

function parseGeneratedProfile(value: string): Profile {
  if (value === "microservice") {
    return value;
  }
  if (value === "app") {
    throw new Error("The app profile has moved out of create-service");
  }
  throw new Error(`Unknown generated profile: ${value}`);
}

function createScaffoldConfig(
  item: ValidationPlanItem,
  generatedRoot: string,
  generatorRoot: string
): ScaffoldConfig {
  const defaults = deriveDefaults(item.serviceName);
  const gcpProjectMode: GcpProjectMode = "create_new";

  return {
    directory: generatedRoot,
    serviceName: item.serviceName,
    modulePath: `example.com/${item.serviceName}`,
    runtime: item.runtime,
    framework: item.framework,
    target: item.target,
    profile: item.profile,
    region: "us-west1",
    gcpProjectMode,
    gcpProject: defaults.projectId,
    gcpProjectName: defaults.projectName,
    billingAccount: "billingAccounts/01BD2E-3A6949-8F4C84",
    quotaProjectId: "anmho-infra-prod",
    autoDeploy: false,
    git: {
      enabled: false,
      owner: "anmho",
      repository: item.serviceName,
    },
    neonDatabaseName: defaults.neonDatabaseName,
    apiHostname: defaults.apiHostname,
    generatorRoot,
  };
}

async function runCommand(command: string[], options: RunCommandOptions) {
  const result = await runProcess(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `command failed: ${command.join(" ")}`,
        `exit code: ${result.exitCode}`,
        result.output ? `output:\n${result.output}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

async function runProcess(command: string[], options: RunCommandOptions) {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    output: `${stdout}${stderr}`.trim(),
  };
}

function isDockerComposeUp(step: ValidationCommandStep) {
  return step.command.join(" ") === "docker compose up -d";
}

async function stopDockerCompose(cwd: string, item: ValidationPlanItem) {
  try {
    await runCommand(["docker", "compose", "down", "-v", "--remove-orphans"], {
      cwd,
      env: { COMPOSE_PROJECT_NAME: item.composeProjectName },
    });
  } catch (error) {
    console.error(`docker compose cleanup failed in ${cwd}: ${formatError(error)}`);
  }
}

function commandEnv(item: ValidationPlanItem, step: ValidationCommandStep) {
  return { COMPOSE_PROJECT_NAME: item.composeProjectName };
}

async function runSmokeCheck(item: ValidationPlanItem, cwd: string, smoke: SmokeCheck) {
  const port = await getOpenPort();
  const command = item.runtime === "bun" ? ["bun", "run", "dev"] : ["make", "dev"];
  const proc = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      ENABLE_RPC_INTROSPECTION: "true",
      COMPOSE_PROJECT_NAME: item.composeProjectName,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  try {
    if (smoke.kind === "connect-client") {
      const protocol = item.name === "bun-connectrpc" ? "http2" : "http";
      await waitForHttp(`${protocol}://127.0.0.1:${port}/healthz`, 200, proc);
      await runConnectClientSmoke(item, cwd, port);
    } else {
      if (!smoke.path) {
        throw new Error(`Smoke check ${smoke.name} is missing a path`);
      }
      const protocol = smoke.protocol === "http2" ? "http2" : "http";
      await waitForHttp(`${protocol}://127.0.0.1:${port}${smoke.path}`, smoke.expectStatus ?? 200, proc);
    }
  } finally {
    terminateProcessGroup(proc);
    await proc.exited.catch(() => {});
  }
}

async function runConnectClientSmoke(item: ValidationPlanItem, cwd: string, port: number) {
  if (item.name === "bun-connectrpc") {
    const smokePath = join(cwd, ".create-svc-connect-smoke.ts");
    await Bun.write(
      smokePath,
      [
        'import { createClient } from "@connectrpc/connect";',
        'import { createConnectTransport } from "@connectrpc/connect-node";',
        'import { WaitlistService } from "./gen/protos/waitlist/v1/waitlist_pb.js";',
        "",
        'const baseUrl = Bun.env.BASE_URL;',
        'if (!baseUrl) throw new Error("BASE_URL is required");',
        'const transport = createConnectTransport({ baseUrl, httpVersion: "2" });',
        "const client = createClient(WaitlistService, transport);",
        'const email = `smoke-${Date.now()}@example.com`;',
        "const response = await client.joinWaitlist({ email }, { timeoutMs: 10_000 });",
        'if (response.entry?.email !== email) throw new Error("typed Connect client smoke failed");',
        "",
      ].join("\n")
    );
    await runCommand(["bun", "run", smokePath], {
      cwd,
      env: { BASE_URL: `http://127.0.0.1:${port}` },
    });
    return;
  }

  if (item.name === "go-connectrpc") {
    const smokePath = join(cwd, "create_svc_connect_smoke.go");
    await Bun.write(
      smokePath,
      [
        "package main",
        "",
        "import (",
        '\t"context"',
        '\t"crypto/tls"',
        '\t"fmt"',
        '\t"net"',
        '\t"net/http"',
        '\t"os"',
        '\t"time"',
        "",
        '\t"connectrpc.com/connect"',
        `\twaitlistv1 "example.com/${item.serviceName}/gen/waitlist/v1"`,
        `\twaitlistv1connect "example.com/${item.serviceName}/gen/waitlist/v1/waitlistv1connect"`,
        '\t"golang.org/x/net/http2"',
        ")",
        "",
        "func main() {",
        '\tbaseURL := os.Getenv("BASE_URL")',
        '\tif baseURL == "" { panic("BASE_URL is required") }',
        "\ttransport := &http2.Transport{",
        "\t\tAllowHTTP: true,",
        "\t\tDialTLSContext: func(ctx context.Context, network string, addr string, _ *tls.Config) (net.Conn, error) {",
        "\t\t\tvar dialer net.Dialer",
        "\t\t\treturn dialer.DialContext(ctx, network, addr)",
        "\t\t},",
        "\t}",
        "\thttpClient := &http.Client{Transport: transport, Timeout: 10 * time.Second}",
        "\tclient := waitlistv1connect.NewWaitlistServiceClient(httpClient, baseURL, connect.WithGRPC())",
        '\temail := fmt.Sprintf("smoke-%d@example.com", time.Now().UnixNano())',
        "\tresponse, err := client.JoinWaitlist(context.Background(), connect.NewRequest(&waitlistv1.JoinWaitlistRequest{Email: email}))",
        "\tif err != nil { panic(err) }",
        '\tif response.Msg.Entry == nil || response.Msg.Entry.Email != email { panic("typed gRPC client smoke failed") }',
        "}",
        "",
      ].join("\n")
    );
    await runCommand(["go", "run", smokePath], {
      cwd,
      env: { BASE_URL: `http://127.0.0.1:${port}` },
    });
    return;
  }

  throw new Error(`No typed client smoke is defined for ${item.name}`);
}

async function waitForHttp(url: string, expectedStatus: number, proc: ServerProcess) {
  const started = Date.now();
  let lastError = "";

  while (Date.now() - started < 30_000) {
    if (proc.exitCode !== null) {
      const output = await readProcessOutput(proc);
      throw new Error(formatEarlyExit(output));
    }

    try {
      const status = await requestSmokeStatus(url, proc);
      if (status === expectedStatus) {
        return;
      }
      lastError = `expected ${expectedStatus}, got ${status}`;
    } catch (error) {
      lastError = formatError(error);
    }

    await Bun.sleep(500);
  }

  terminateProcessGroup(proc);
  await proc.exited.catch(() => {});
  const output = await readProcessOutput(proc);
  throw new Error(`timed out waiting for ${url}: ${lastError}\n${output}`);
}

function formatEarlyExit(output: string) {
  if (output.includes("Cannot connect to the Docker daemon")) {
    return `environment blocker: Docker daemon is not running\n${output}`;
  }
  return `server exited before smoke check passed\n${output}`;
}

function terminateProcessGroup(proc: ServerProcess) {
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill();
  }
}

async function requestSmokeStatus(url: string, proc: ServerProcess) {
  const parsed = new URL(url);
  const useHttp2 = parsed.protocol === "http2:";
  if (!useHttp2) {
    const response = await fetch(url, { signal: AbortSignal.timeout(SMOKE_REQUEST_TIMEOUT_MS) });
    return response.status;
  }

  return new Promise<number>((resolveStatus, reject) => {
    const client = connectHttp2(`http://${parsed.host}`);
    const timeout = setTimeout(() => {
      rejectOnce(new Error(`HTTP/2 smoke request timed out after ${SMOKE_REQUEST_TIMEOUT_MS}ms`));
    }, SMOKE_REQUEST_TIMEOUT_MS);
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      client.destroy(error);
      reject(error);
    };
    const resolveOnce = (status: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      request.close();
      client.close();
      resolveStatus(status);
    };

    client.on("error", (error) => {
      rejectOnce(error);
    });

    const request = client.request({
      [http2Constants.HTTP2_HEADER_METHOD]: "GET",
      [http2Constants.HTTP2_HEADER_PATH]: `${parsed.pathname}${parsed.search}`,
    });

    request.setEncoding("utf8");
    request.on("response", (headers) => {
      const status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
      resolveOnce(status);
    });
    request.on("data", () => {});
    request.on("end", () => client.close());
    request.on("error", (error) => {
      if (proc.exitCode !== null) {
        rejectOnce(new Error(`server exited before HTTP/2 smoke response: ${formatError(error)}`));
        return;
      }
      rejectOnce(error);
    });
    request.end();
  });
}

async function readProcessOutput(proc: ServerProcess) {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  return `${stdout}${stderr}`.trim();
}

async function getOpenPort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  validateGeneratedApps().catch((error) => {
    console.error(formatError(error));
    process.exit(1);
  });
}
