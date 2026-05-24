import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGitBootstrapConfig,
  commitAndPushGeneratedArtifacts,
  findExistingGitWorktree,
  manualGitHubDeleteCommand,
  markGitHubRepositoryDeleteOnDestroy,
} from "./git-bootstrap";

test("buildGitBootstrapConfig defaults to anmho private repo creation", () => {
  expect(buildGitBootstrapConfig("launch-api", undefined)).toEqual({
    enabled: true,
    owner: "anmho",
    repository: "launch-api",
  });
});

test("buildGitBootstrapConfig honors --no-git", () => {
  expect(buildGitBootstrapConfig("launch-api", true)).toEqual({
    enabled: false,
    owner: "anmho",
    repository: "launch-api",
  });
});

test("manualGitHubDeleteCommand formats the advisory cleanup command", () => {
  expect(manualGitHubDeleteCommand("anmho/launch-api")).toBe("gh repo delete anmho/launch-api --yes");
});

test("findExistingGitWorktree detects parent repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-git-"));
  run(["git", "init", "-b", "main"], root);
  await mkdir(join(root, "apps", "launch-api"), { recursive: true });

  expect(findExistingGitWorktree(join(root, "apps", "launch-api"))).toBe(await realpath(root));
});

test("markGitHubRepositoryDeleteOnDestroy records generated repo ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-git-"));
  await writeFile(join(root, "service.jsonc"), '{\n  "git": { "delete_on_destroy": false }\n}\n');

  await markGitHubRepositoryDeleteOnDestroy(root);

  expect(await Bun.file(join(root, "service.jsonc")).text()).toContain('"delete_on_destroy": true');
});

test("commitAndPushGeneratedArtifacts excludes local dependencies and dev runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-git-"));
  const remote = await mkdtemp(join(tmpdir(), "create-svc-remote-"));
  run(["git", "init", "--bare"], remote);
  run(["git", "init", "-b", "main"], root);
  run(["git", "remote", "add", "origin", remote], root);
  await writeFile(join(root, "README.md"), "# generated\n");
  run(["git", "add", "."], root);
  run(["git", "commit", "-m", "Initial commit"], root);
  run(["git", "push", "-u", "origin", "main"], root);

  await mkdir(join(root, "node_modules", "large-package"), { recursive: true });
  await mkdir(join(root, ".service"), { recursive: true });
  await mkdir(join(root, ".wrangler", "tmp"), { recursive: true });
  await writeFile(join(root, "node_modules", "large-package", "artifact.bin"), "large");
  await writeFile(join(root, ".service", "local-dev.log"), "log");
  await writeFile(join(root, ".service", "local-dev.pid"), "123");
  await writeFile(join(root, ".wrangler", "tmp", "bundle.js"), "bundle");
  await writeFile(join(root, "service.jsonc"), '{ "deployed": true }\n');

  expect(commitAndPushGeneratedArtifacts(root, "Record generated deployment artifacts")).toEqual({ committed: true });

  expect(git(["ls-files"], root)).toContain("service.jsonc");
  expect(git(["ls-files"], root)).not.toContain("node_modules");
  expect(git(["ls-files"], root)).not.toContain(".service/local-dev.log");
  expect(git(["ls-files"], root)).not.toContain(".wrangler");
});

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

function git(command: string[], cwd: string) {
  const result = Bun.spawnSync(["git", ...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
}
