import { expect, test } from "bun:test";
import { discoverNeonDefaults, listBranches, listProjects, type NeonApi } from "./neon";

test("listProjects and listBranches sort results", async () => {
  const api: NeonApi = {
    async listProjects() {
      return [
        { id: "p1", name: "alpha" },
        { id: "p2", name: "zulu" },
      ];
    },
    async listBranches() {
      return [
        { id: "b1", name: "main" },
        { id: "b2", name: "zeta" },
      ];
    },
  };

  await expect(listProjects(api)).resolves.toEqual([
    { id: "p1", name: "alpha" },
    { id: "p2", name: "zulu" },
  ]);
  await expect(listBranches("p1", api)).resolves.toEqual([
    { id: "b1", name: "main" },
    { id: "b2", name: "zeta" },
  ]);
});

test("discoverNeonDefaults prefers the main branch", async () => {
  const api: NeonApi = {
    async listProjects() {
      return [{ id: "project-1", name: "shared" }];
    },
    async listBranches() {
      return [
        { id: "branch-2", name: "feature" },
        { id: "branch-1", name: "main" },
      ];
    },
  };

  await expect(discoverNeonDefaults("dns-api", api)).resolves.toEqual({
    projectId: "project-1",
    baseBranchId: "branch-1",
    baseBranchName: "main",
  });
});
