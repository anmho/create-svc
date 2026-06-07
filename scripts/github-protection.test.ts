import { expect, test } from "bun:test";
import {
  buildBranchProtectionRequest,
  formatProtectionFailure,
  protectMainBranch,
  type CommandRunner,
} from "../src/github-protection";

test("builds the GitHub branch protection request for generated services", () => {
  expect(buildBranchProtectionRequest()).toEqual({
    required_status_checks: {
      strict: true,
      contexts: ["test"],
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
  });
});

test("sends the expected GitHub API request to reconcile main protection", async () => {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const runner: CommandRunner = (command, args, options) => {
    calls.push({ command, args, input: options?.input });
    return {
      success: true,
      stdout: JSON.stringify({ required_status_checks: { contexts: ["test"] } }),
      stderr: "",
      exitCode: 0,
    };
  };

  const result = await protectMainBranch({ repo: "anmho/dns-api", runner });

  expect(calls).toEqual([
    {
      command: "gh",
      args: ["api", "--method", "PUT", "/repos/anmho/dns-api/branches/main/protection", "--input", "-"],
      input: `${JSON.stringify(buildBranchProtectionRequest())}\n`,
    },
    {
      command: "gh",
      args: ["api", "/repos/anmho/dns-api/branches/main/protection"],
      input: undefined,
    },
  ]);
  expect(result).toEqual({
    repo: "anmho/dns-api",
    branch: "main",
    requiredChecks: ["test"],
    verified: true,
  });
});

test("verifies required checks from GitHub protection readback checks array", async () => {
  const runner: CommandRunner = (_command, args) => {
    const isReadback = args[0] === "api" && args.length === 2;
    return {
      success: true,
      stdout: isReadback
        ? JSON.stringify({ required_status_checks: { contexts: [], checks: [{ context: "lint" }, { name: "test" }] } })
        : "{}",
      stderr: "",
      exitCode: 0,
    };
  };

  expect(protectMainBranch({ repo: "anmho/dns-api", requiredChecks: ["test"], runner })).toEqual({
    repo: "anmho/dns-api",
    branch: "main",
    requiredChecks: ["test"],
    verified: true,
  });
});

test("fails when GitHub readback has no required checks", async () => {
  const runner: CommandRunner = (_command, args) => {
    const isReadback = args[0] === "api" && args.length === 2;
    return {
      success: true,
      stdout: isReadback ? JSON.stringify({ required_status_checks: { contexts: [], checks: [] } }) : "{}",
      stderr: "",
      exitCode: 0,
    };
  };

  expect(() => protectMainBranch({ repo: "anmho/dns-api", runner })).toThrow("GitHub returned required checks: (none)");
  expect(() => protectMainBranch({ repo: "anmho/dns-api", runner })).toThrow(
    "Rerun: service protect-main --repo anmho/dns-api --branch main"
  );
});

test("rejects empty required checks before calling GitHub", () => {
  const calls: string[] = [];
  const runner: CommandRunner = (command) => {
    calls.push(command);
    return { success: true, stdout: "{}", stderr: "", exitCode: 0 };
  };

  expect(() => protectMainBranch({ repo: "anmho/dns-api", requiredChecks: [], runner })).toThrow(
    "Branch protection requires at least one required status check"
  );
  expect(calls).toEqual([]);
});

test("formats GitHub permission failures with the required permission and rerun command", () => {
  const message = formatProtectionFailure("anmho/dns-api", "main", {
    success: false,
    stdout: "",
    stderr: "HTTP 403: Resource not accessible by integration",
    exitCode: 1,
  });

  expect(message).toContain("Failed to reconcile main branch protection for anmho/dns-api");
  expect(message).toContain("Administration: write");
  expect(message).toContain("service protect-main");
});
