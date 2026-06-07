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

type BranchProtectionVerification = {
  actualChecks: string[];
  missingChecks: string[];
};

const DEFAULT_BRANCH = "main";
const DEFAULT_REQUIRED_CHECKS = ["test"];
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
  const requiredChecks = normalizeRequiredChecks(options.requiredChecks ?? DEFAULT_REQUIRED_CHECKS);
  const request = buildBranchProtectionRequest(requiredChecks);
  const endpoint = `/repos/${repo}/branches/${branch}/protection`;
  const result = runner("gh", ["api", "--method", "PUT", endpoint, "--input", "-"], {
    cwd: options.cwd,
    input: `${JSON.stringify(request)}\n`,
  });

  if (!result.success) {
    throw new Error(formatProtectionFailure(repo, branch, result));
  }

  const readback = runner("gh", ["api", endpoint], { cwd: options.cwd });
  if (!readback.success) {
    throw new Error(formatProtectionFailure(repo, branch, readback));
  }

  const verification = verifyBranchProtection(requiredChecks, readback.stdout);
  if (verification.missingChecks.length > 0) {
    throw new Error(formatProtectionVerificationFailure(repo, branch, requiredChecks, verification.actualChecks));
  }

  return {
    repo,
    branch,
    requiredChecks,
    verified: true,
  };
}

export function buildBranchProtectionRequest(requiredChecks = DEFAULT_REQUIRED_CHECKS): BranchProtectionRequest {
  const normalizedChecks = normalizeRequiredChecks(requiredChecks);
  return {
    required_status_checks: {
      strict: true,
      contexts: normalizedChecks,
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

export function formatProtectionVerificationFailure(repo: string, branch: string, expectedChecks: string[], actualChecks: string[]) {
  const actual = actualChecks.length > 0 ? actualChecks.join(", ") : "(none)";
  return [
    `Failed to verify ${branch} branch protection for ${repo}.`,
    `Expected required checks: ${expectedChecks.join(", ")}`,
    `GitHub returned required checks: ${actual}`,
    `Rerun: service protect-main --repo ${repo} --branch ${branch}`,
  ].join("\n");
}

function verifyBranchProtection(expectedChecks: string[], raw: string): BranchProtectionVerification {
  const actualChecks = requiredChecksFromProtectionResponse(raw);
  const actual = new Set(actualChecks);
  const missingChecks = expectedChecks.filter((check) => !actual.has(check));
  return { actualChecks, missingChecks };
}

function requiredChecksFromProtectionResponse(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const requiredStatusChecks = (parsed as { required_status_checks?: unknown })?.required_status_checks;
  if (!requiredStatusChecks || typeof requiredStatusChecks !== "object") {
    return [];
  }

  const checks = new Set<string>();
  const contexts = (requiredStatusChecks as { contexts?: unknown }).contexts;
  if (Array.isArray(contexts)) {
    for (const context of contexts) {
      if (typeof context === "string" && context.trim()) {
        checks.add(context.trim());
      }
    }
  }

  const checkRuns = (requiredStatusChecks as { checks?: unknown }).checks;
  if (Array.isArray(checkRuns)) {
    for (const checkRun of checkRuns) {
      if (!checkRun || typeof checkRun !== "object") {
        continue;
      }
      const context = (checkRun as { context?: unknown }).context;
      const name = (checkRun as { name?: unknown }).name;
      for (const value of [context, name]) {
        if (typeof value === "string" && value.trim()) {
          checks.add(value.trim());
        }
      }
    }
  }

  return [...checks];
}

function normalizeRequiredChecks(requiredChecks: string[]) {
  const normalized = [...new Set(requiredChecks.map((check) => check.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("Branch protection requires at least one required status check");
  }
  return normalized;
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
