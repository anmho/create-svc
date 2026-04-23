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

const decoder = new TextDecoder();

export async function runPostScaffoldFlow(config: ScaffoldConfig, cwd: string) {
  if (config.createGithubRepo) {
    initializeRepository(cwd);
    createGitHubRepo(config, cwd);
  }

  if (config.autoDeploy) {
    installProjectDependencies(cwd);
    run("bun", ["run", "bootstrap"], { cwd });
    run("bun", ["run", "deploy"], { cwd });
    return { message: "Repository initialized, pushed, and first deploy started" };
  }

  return { message: "Repository initialized" };
}

function initializeRepository(cwd: string) {
  requireCommand("git");
  run("git", ["init", "-b", "main"], { cwd, allowFailure: true });
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "--allow-empty", "-m", "Initial commit"], { cwd, allowFailure: true });
}

function createGitHubRepo(config: ScaffoldConfig, cwd: string) {
  requireCommand("gh");

  const existing = run("gh", ["repo", "view", config.githubRepo], { cwd, allowFailure: true });
  if (!existing.success) {
    run("gh", ["repo", "create", config.githubRepo, `--${config.githubVisibility}`, "--source=.", "--remote=origin"], { cwd });
  }

  run("git", ["push", "-u", "origin", "main"], { cwd, allowFailure: true });
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
    stdin: options.input,
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
