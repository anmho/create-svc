type CommandOptions = {
  cwd?: string;
  input?: string;
};

type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => CommandResult;

export type ProtectionOptions = {
  repo?: string;
  branch?: string;
  requiredChecks?: string[];
  cwd?: string;
  runner?: CommandRunner;
};

export type BranchProtectionRequest = {
  required_status_checks: {
    strict: boolean;
    contexts: string[];
  };
  enforce_admins: boolean;
  required_pull_request_reviews: {
    dismiss_stale_reviews: boolean;
    required_approving_review_count: number;
  };
  restrictions: null;
  required_linear_history: boolean;
  allow_force_pushes: boolean;
  allow_deletions: boolean;
  block_creations: boolean;
  required_conversation_resolution: boolean;
  lock_branch: boolean;
  allow_fork_syncing: boolean;
};

const DEFAULT_BRANCH = "main";
const DEFAULT_REQUIRED_CHECKS = ["test", "deploy"];
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function parseProtectMainArgs(argv: string[]) {
  const parsed: Pick<ProtectionOptions, "repo" | "branch"> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    const next = argv[index + 1];
    const readValue = () => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${token}`);
      }
      index += 1;
      return next;
    };

    if (token === "--repo") {
      parsed.repo = readValue();
      continue;
    }

    if (token.startsWith("--repo=")) {
      parsed.repo = token.slice("--repo=".length);
      continue;
    }

    if (token === "--branch") {
      parsed.branch = readValue();
      continue;
    }

    if (token.startsWith("--branch=")) {
      parsed.branch = token.slice("--branch=".length);
      continue;
    }

    throw new Error(`Unknown argument for protect-main: ${token}`);
  }

  return parsed;
}

export function protectMainBranch(options: ProtectionOptions = {}) {
  const runner = options.runner ?? run;
  const repo = normalizeRepo(options.repo ?? process.env.GITHUB_REPOSITORY ?? discoverRepo(runner, options.cwd));
  const branch = options.branch ?? DEFAULT_BRANCH;
  const requiredChecks = options.requiredChecks ?? DEFAULT_REQUIRED_CHECKS;
  const request = buildBranchProtectionRequest(requiredChecks);
  const endpoint = `/repos/${repo}/branches/${branch}/protection`;
  const result = runner("gh", ["api", "--method", "PUT", endpoint, "--input", "-"], {
    cwd: options.cwd,
    input: `${JSON.stringify(request)}\n`,
  });

  if (!result.success) {
    throw new Error(formatProtectionFailure(repo, branch, result));
  }

  return {
    repo,
    branch,
    requiredChecks,
  };
}

export function buildBranchProtectionRequest(requiredChecks = DEFAULT_REQUIRED_CHECKS): BranchProtectionRequest {
  return {
    required_status_checks: {
      strict: true,
      contexts: requiredChecks,
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      required_approving_review_count: 1,
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: true,
  };
}

export function formatProtectionFailure(repo: string, branch: string, result: CommandResult) {
  const details = [result.stderr, result.stdout].filter(Boolean).join("\n");
  const permissionHint = isPermissionFailure(details)
    ? [
        "",
        "The authenticated GitHub token must have repository administration permission for this generated service repo.",
        "Grant repo admin access or a fine-grained token with Administration: write, then rerun `service protect-main`.",
      ].join("\n")
    : "";

  return [`Failed to reconcile ${branch} branch protection for ${repo}.`, details, permissionHint].filter(Boolean).join("\n");
}

function discoverRepo(runner: CommandRunner, cwd?: string) {
  const result = runner("git", ["config", "--get", "remote.origin.url"], { cwd });
  if (!result.success || !result.stdout) {
    throw new Error("Unable to determine GitHub repo. Pass --repo owner/name or set GITHUB_REPOSITORY.");
  }
  return result.stdout;
}

function normalizeRepo(value: string) {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  const urlMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return trimmed.replace(/\.git$/, "");
  }

  throw new Error(`Invalid GitHub repo: ${value}. Expected owner/name.`);
}

function isPermissionFailure(details: string) {
  return /403|404|admin|administration|resource not accessible|not found|forbidden/i.test(details);
}

function run(command: string, args: string[], options: CommandOptions = {}): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    stdin: options.input === undefined ? undefined : encoder.encode(options.input),
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    success: result.success,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : "",
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : "",
    exitCode: result.exitCode,
  };
}
