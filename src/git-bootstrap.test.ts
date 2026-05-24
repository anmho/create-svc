import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGitBootstrapConfig, findExistingGitWorktree, markGitHubRepositoryDeleteOnDestroy } from "./git-bootstrap";

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
