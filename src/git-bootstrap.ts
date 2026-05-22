import { existsSync } from "node:fs";
import { dirname } from "node:path";

export type GitBootstrapConfig = {
  enabled: boolean;
  owner: string;
  repository: string;
};

export type GitBootstrapResult =
  | { status: "disabled" }
  | { status: "skipped-existing-worktree"; root: string }
  | { status: "created"; url: string };

export function buildGitBootstrapConfig(serviceName: string, noGit: boolean | undefined): GitBootstrapConfig {
  return {
    enabled: !noGit,
    owner: "anmho",
    repository: serviceName,
  };
}

export async function bootstrapGitHubRepository(targetDir: string, config: GitBootstrapConfig): Promise<GitBootstrapResult> {
  if (!config.enabled) {
    return { status: "disabled" };
  }

  const existingRoot = findExistingGitWorktree(targetDir);
  if (existingRoot) {
    return { status: "skipped-existing-worktree", root: existingRoot };
  }

  run(["git", "--version"], targetDir, "git is required to initialize the generated repository");
  run(["gh", "--version"], targetDir, "GitHub CLI `gh` is required to create the generated repository");
  run(["gh", "auth", "status"], targetDir, "Authenticate GitHub CLI with `gh auth login` before creating the repository");

  run(["git", "init", "-b", "main"], targetDir);
  run(["git", "add", "."], targetDir);

  if (hasStagedChanges(targetDir)) {
    run(["git", "commit", "-m", "Initial commit"], targetDir);
  }

  const repository = `${config.owner}/${config.repository}`;
  run(["gh", "repo", "create", repository, "--private", "--source", ".", "--remote", "origin", "--push"], targetDir);

  return {
    status: "created",
    url: `https://github.com/${repository}`,
  };
}

export function findExistingGitWorktree(targetDir: string) {
  const cwd = existingPath(targetDir);
  const result = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.toString().trim() || undefined;
}

function existingPath(path: string): string {
  if (existsSync(path)) {
    return path;
  }

  const parent = dirname(path);
  if (parent === path) {
    return path;
  }

  return existingPath(parent);
}

function hasStagedChanges(cwd: string) {
  const result = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 1;
}

function run(command: string[], cwd: string, message?: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return;
  }

  const detail = result.stderr.toString().trim();
  throw new Error([message, `Command failed: ${command.join(" ")}`, detail].filter(Boolean).join("\n"));
}
