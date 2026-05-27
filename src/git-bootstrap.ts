import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { protectMainBranch } from "./github-protection";

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

export function manualGitHubDeleteCommand(repository: string) {
  return `gh repo delete ${repository} --yes`;
}

export async function bootstrapGitHubRepository(targetDir: string, config: GitBootstrapConfig): Promise<GitBootstrapResult> {
  if (!config.enabled) {
    return { status: "disabled" };
  }

  const existingRoot = findExistingGitWorktree(targetDir);
  if (existingRoot) {
    return { status: "skipped-existing-worktree", root: existingRoot };
  }

  run(["git", "--version"], targetDir, "git is required to initialize the generated repository", { quiet: true });
  run(["gh", "--version"], targetDir, "GitHub CLI `gh` is required to create the generated repository", { quiet: true });
  run(["gh", "auth", "status"], targetDir, "Authenticate GitHub CLI with `gh auth login` before creating the repository", { quiet: true });

  run(["git", "init", "-b", "main", "--quiet"], targetDir);
  run(["git", "add", "."], targetDir);

  if (hasStagedChanges(targetDir)) {
    run(["git", "commit", "--quiet", "-m", "Initial commit"], targetDir);
  }

  const repository = `${config.owner}/${config.repository}`;
  run(["gh", "repo", "create", repository, "--private", "--source", ".", "--remote", "origin", "--push"], targetDir, undefined, {
    quiet: true,
  });
  protectMainBranch({ repo: repository, cwd: targetDir });

  return {
    status: "created",
    url: `https://github.com/${repository}`,
  };
}

export function commitAndPushGeneratedArtifacts(targetDir: string, message: string) {
  run(
    [
      "git",
      "add",
      "--all",
      ".",
      ":!node_modules",
      ":!.service/*.log",
      ":!.service/*.pid",
      ":!.wrangler",
    ],
    targetDir
  );
  if (!hasStagedChanges(targetDir)) {
    return { committed: false };
  }
  run(["git", "commit", "--quiet", "-m", message], targetDir);
  run(["git", "push", "--quiet"], targetDir, undefined, { quiet: true });
  return { committed: true };
}

export async function markGitHubRepositoryDeleteOnDestroy(targetDir: string) {
  const path = `${targetDir}/service.jsonc`;
  const text = await readFile(path, "utf8");
  const updated = text.replace('"delete_on_destroy": false', '"delete_on_destroy": true');
  if (updated === text) {
    throw new Error("service.jsonc does not contain a delete_on_destroy marker");
  }
  await writeFile(path, updated);
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

function run(command: string[], cwd: string, message?: string, options: { quiet?: boolean } = {}) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: "inherit",
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return;
  }

  const output = result.stdout?.toString().trim() ?? "";
  const detail = result.stderr.toString().trim();
  throw new Error([message, `Command failed: ${command.join(" ")}`, output, detail].filter(Boolean).join("\n"));
}
