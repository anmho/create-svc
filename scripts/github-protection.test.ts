import { expect, test } from "bun:test";
import {
  buildBranchProtectionRequest,
  formatProtectionFailure,
  protectMainBranch,
  type CommandRunner,
} from "../src/github-protection";

test("builds the GitHub branch protection request for generated services", () => {
  expect(buildBranchProtectionRequest(["test", "deploy"])).toEqual({
    required_status_checks: {
      strict: true,
      contexts: ["test", "deploy"],
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
    return { success: true, stdout: "{}", stderr: "", exitCode: 0 };
  };

  await protectMainBranch({ repo: "anmho/dns-api", runner });

  expect(calls).toEqual([
    {
      command: "gh",
      args: ["api", "--method", "PUT", "/repos/anmho/dns-api/branches/main/protection", "--input", "-"],
      input: `${JSON.stringify(buildBranchProtectionRequest(["test", "deploy"]))}\n`,
    },
  ]);
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
