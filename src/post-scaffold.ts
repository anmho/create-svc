import type { ScaffoldConfig } from "./scaffold";

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

export async function runPostScaffoldFlow(config: ScaffoldConfig, cwd: string) {
  if (config.autoDeploy) {
    installProjectDependencies(cwd);
    for (const command of buildPostScaffoldCommands(config)) {
      run(command.command, command.args, { cwd });
    }
    for (const command of buildDeploymentVerificationCommands(config)) {
      run(command.command, command.args, { cwd, quiet: true });
    }
    return { message: "Dependencies installed, service created, service deployed, and production health verified" };
  }

  return { message: "Backend package generated" };
}

export function buildDeploymentVerificationCommands(
  config: Pick<ScaffoldConfig, "apiHostname" | "framework" | "runtime">
): PostScaffoldCommand[] {
  const origin = `https://${config.apiHostname}`;
  return [
    { command: "curl", args: ["--fail", "--show-error", "--silent", `${origin}/healthz`] },
    { command: "curl", args: ["--fail", "--show-error", "--silent", `${origin}/readyz`] },
    ...(config.framework === "connectrpc"
      ? [
          config.runtime === "go"
            ? { command: "grpcurl", args: [`${config.apiHostname}:443`, "list"] }
            : { command: "curl", args: ["--fail", "--show-error", "--silent", `${origin}/debug/connectrpc`] },
        ]
      : []),
  ];
}

export function buildPostScaffoldCommands(config: Pick<ScaffoldConfig, "framework">): PostScaffoldCommand[] {
  return [
    ...(config.framework === "connectrpc" ? [{ command: "bun", args: ["./scripts/cloudrun/cli.ts", "sdk", "build"] }] : []),
    { command: "bun", args: ["./scripts/cloudrun/cli.ts", "create"] },
    { command: "bun", args: ["./scripts/cloudrun/cli.ts", "deploy"] },
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
    env: process.env,
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
