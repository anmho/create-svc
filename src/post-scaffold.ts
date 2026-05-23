import type { ScaffoldConfig } from "./scaffold";

type CommandOptions = {
  cwd: string;
  allowFailure?: boolean;
  input?: string;
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
    return { message: "Dependencies installed, service created, and service deployed" };
  }

  return { message: "Backend package generated" };
}

export function buildPostScaffoldCommands(config: Pick<ScaffoldConfig, "framework">): PostScaffoldCommand[] {
  return [
    ...(config.framework === "connectrpc" ? [{ command: "bun", args: ["run", "service", "--", "sdk", "build"] }] : []),
    { command: "bun", args: ["run", "service", "--", "create"] },
    { command: "bun", args: ["run", "service", "--", "deploy"] },
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
    stdout: options.allowFailure ? "pipe" : "inherit",
    stderr: options.allowFailure ? "pipe" : "inherit",
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
