import type { ScaffoldConfig } from "./scaffold";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

type CommandOptions = {
  cwd: string;
  allowFailure?: boolean;
  input?: string;
  quiet?: boolean;
};

type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

type PostScaffoldCommand = {
  command: string;
  args: string[];
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const DEPLOYMENT_VERIFY_ATTEMPTS = 36;
const DEPLOYMENT_VERIFY_DELAY_MS = 10_000;

export async function runPostScaffoldFlow(config: ScaffoldConfig, cwd: string) {
  if (config.autoDeploy) {
    installProjectDependencies(cwd);
    for (const command of buildPostScaffoldCommands(config)) {
      run(command.command, command.args, { cwd });
    }
    for (const command of buildDeploymentVerificationCommands(config)) {
      runWithRetries(command, { cwd, quiet: true }, DEPLOYMENT_VERIFY_ATTEMPTS, DEPLOYMENT_VERIFY_DELAY_MS);
    }
    await startLocalDevelopment(config, cwd);
    for (const command of buildLocalVerificationCommands(config)) {
      runWithRetries(command, { cwd, quiet: true }, 18, 5_000);
    }
    return { message: "Dependencies installed, service created, production verified, and local dev started" };
  }

  return { message: "Backend package generated" };
}

async function startLocalDevelopment(config: Pick<ScaffoldConfig, "target">, cwd: string) {
  run("bun", ["run", "migrate"], { cwd });
  await mkdir(join(cwd, ".service"), { recursive: true });
  const child = Bun.spawn(["sh", "-c", "exec bun run dev > .service/local-dev.log 2>&1 < /dev/null"], {
    cwd,
    env: postScaffoldEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  await Bun.write(join(cwd, ".service", "local-dev.pid"), `${child.pid}\n`);
}

function runWithRetries(command: PostScaffoldCommand, options: CommandOptions, attempts: number, delayMs: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run(command.command, command.args, options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      Bun.sleepSync(delayMs);
    }
  }
  throw lastError;
}

export function buildDeploymentVerificationCommands(
  config: Pick<ScaffoldConfig, "apiHostname" | "framework" | "runtime"> &
    Partial<Pick<ScaffoldConfig, "target" | "serviceName" | "gcpProject" | "region">>
): PostScaffoldCommand[] {
  const origin = verificationOrigin(config);
  const tokenCommand = 'TOKEN="$(service auth token)"';
  return [
    shellVerificationCommand(`curl --fail --show-error --silent "${origin}/"`),
    shellVerificationCommand(`curl --fail --show-error --silent "${origin}/readyz"`),
    protectedVerificationCommand(config, origin, tokenCommand),
  ];
}

export function buildLocalVerificationCommands(
  config: Pick<ScaffoldConfig, "apiHostname" | "framework" | "runtime"> & Partial<Pick<ScaffoldConfig, "target">>
): PostScaffoldCommand[] {
  const origin = localVerificationOrigin(config);
  const tokenCommand = 'TOKEN="$(service auth token)"';
  return [
    shellVerificationCommand(`curl --fail --show-error --silent "${origin}/"`),
    shellVerificationCommand(`curl --fail --show-error --silent "${origin}/readyz"`),
    protectedLocalVerificationCommand(config, origin, tokenCommand),
  ];
}

function protectedVerificationCommand(
  config: Pick<ScaffoldConfig, "apiHostname" | "framework" | "runtime"> &
    Partial<Pick<ScaffoldConfig, "target" | "serviceName" | "gcpProject" | "region">>,
  origin: string,
  tokenCommand: string
): PostScaffoldCommand {
  if (config.framework === "connectrpc" && config.runtime === "go") {
    const host = verificationHost(config);
    return {
      command: "sh",
      args: [
        "-c",
        [
          `${tokenCommand} &&`,
          "grpcurl",
          '-H "Authorization: Bearer $TOKEN"',
          "-d '{\"limit\":1}'",
          "-proto protos/waitlist/v1/waitlist.proto",
          `"${host}:443"`,
          "waitlist.v1.WaitlistService/ListWaitlistEntries",
        ].join(" "),
      ],
    };
  }

  if (config.framework === "connectrpc") {
    return {
      command: "sh",
      args: [
        "-c",
        [
          `${tokenCommand} &&`,
          "curl --fail --show-error --silent",
          '-H "Authorization: Bearer $TOKEN"',
          '-H "Content-Type: application/json"',
          "-d '{\"limit\":1}'",
          `"${origin}/waitlist.v1.WaitlistService/ListWaitlistEntries"`,
        ].join(" "),
      ],
    };
  }

  return {
    command: "sh",
    args: [
      "-c",
      [
        `${tokenCommand} &&`,
        "curl --fail --show-error --silent",
        '-H "Authorization: Bearer $TOKEN"',
        `"${origin}/v1/admin/waitlist?limit=1"`,
      ].join(" "),
    ],
  };
}

function protectedLocalVerificationCommand(
  config: Pick<ScaffoldConfig, "apiHostname" | "framework" | "runtime"> & Partial<Pick<ScaffoldConfig, "target">>,
  origin: string,
  tokenCommand: string
): PostScaffoldCommand {
  if (config.framework === "connectrpc" && config.runtime === "go") {
    const host = localVerificationHost(config);
    return {
      command: "sh",
      args: [
        "-c",
        [
          `${tokenCommand} &&`,
          "grpcurl -plaintext",
          '-H "Authorization: Bearer $TOKEN"',
          "-d '{\"limit\":1}'",
          "-proto protos/waitlist/v1/waitlist.proto",
          `"${host}"`,
          "waitlist.v1.WaitlistService/ListWaitlistEntries",
        ].join(" "),
      ],
    };
  }

  return protectedVerificationCommand(config, origin, tokenCommand);
}

function shellVerificationCommand(script: string): PostScaffoldCommand {
  return { command: "sh", args: ["-c", script] };
}

function verificationOrigin(
  config: Partial<Pick<ScaffoldConfig, "target" | "serviceName" | "gcpProject" | "region">> & Pick<ScaffoldConfig, "apiHostname">
) {
  if (config.target !== "workers" && config.serviceName && config.gcpProject && config.region) {
    return `$(gcloud run services describe ${config.serviceName} --project ${config.gcpProject} --region ${config.region} '--format=value(status.url)')`;
  }
  return `https://${config.apiHostname}`;
}

function verificationHost(
  config: Partial<Pick<ScaffoldConfig, "target" | "serviceName" | "gcpProject" | "region">> & Pick<ScaffoldConfig, "apiHostname">
) {
  if (config.target !== "workers" && config.serviceName && config.gcpProject && config.region) {
    return `$(gcloud run services describe ${config.serviceName} --project ${config.gcpProject} --region ${config.region} '--format=value(status.url)' | sed 's#^https://##')`;
  }
  return config.apiHostname;
}

function localVerificationOrigin(config: Partial<Pick<ScaffoldConfig, "target" | "runtime" | "framework">>) {
  if (config.target === "workers") {
    return "http://127.0.0.1:8787";
  }
  if (config.runtime === "bun" && config.framework === "hono") {
    return "http://127.0.0.1:3000";
  }
  return "http://127.0.0.1:8080";
}

function localVerificationHost(config: Partial<Pick<ScaffoldConfig, "target" | "runtime" | "framework">>) {
  return localVerificationOrigin(config).replace(/^https?:\/\//, "");
}

export function buildPostScaffoldCommands(
  config: Pick<ScaffoldConfig, "framework"> & Partial<Pick<ScaffoldConfig, "target">>
): PostScaffoldCommand[] {
  return [
    ...(config.target !== "workers" && config.framework === "connectrpc" ? [{ command: "service", args: ["sdk", "build"] }] : []),
    { command: "service", args: ["create"] },
  ];
}

function installProjectDependencies(cwd: string) {
  requireCommand("bun");
  run("bun", ["install"], { cwd });
}

function requireCommand(name: string) {
  if (!Bun.which(name)) {
    throw new Error(`missing required command for post-scaffold automation: ${name}`);
  }
}

function run(command: string, args: string[], options: CommandOptions): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd: options.cwd,
    env: postScaffoldEnv(),
    stdin: options.input === undefined ? undefined : encoder.encode(options.input),
    stdout: options.allowFailure || options.quiet ? "pipe" : "inherit",
    stderr: options.allowFailure || options.quiet ? "pipe" : "inherit",
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
  };
}

function postScaffoldEnv() {
  const currentBinDir = dirname(Bun.argv[1] ?? "");
  return {
    ...process.env,
    PATH: currentBinDir ? `${currentBinDir}:${process.env.PATH ?? ""}` : process.env.PATH,
  };
}
