import { expect, test } from "bun:test";
import { attachBillingAccount, createProject, listAccessibleProjects, listOpenBillingAccounts, type GcpApi } from "./gcp";

test("listAccessibleProjects filters deleted projects and sorts by name", async () => {
  const api: GcpApi = {
    async listProjects() {
      return [
        { projectId: "b", name: "bravo" },
        { projectId: "a", name: "alpha" },
        { projectId: "z", name: "zulu", lifecycleState: "DELETE_REQUESTED" },
      ];
    },
    async listBillingAccounts() {
      return [];
    },
    async createProject() {},
    async attachBillingAccount() {},
  };

  await expect(listAccessibleProjects(api)).resolves.toEqual([
    { projectId: "a", name: "alpha" },
    { projectId: "b", name: "bravo" },
  ]);
});

test("listOpenBillingAccounts keeps only open accounts", async () => {
  const api: GcpApi = {
    async listProjects() {
      return [];
    },
    async listBillingAccounts() {
      return [
        { name: "billingAccounts/2", displayName: "B", open: true },
        { name: "billingAccounts/1", displayName: "A", open: true },
        { name: "billingAccounts/closed", displayName: "Z", open: false },
      ];
    },
    async createProject() {},
    async attachBillingAccount() {},
  };

  await expect(listOpenBillingAccounts(api)).resolves.toEqual([
    { name: "billingAccounts/1", displayName: "A", open: true },
    { name: "billingAccounts/2", displayName: "B", open: true },
  ]);
});

test("createProject and attachBillingAccount call the expected endpoints", async () => {
  const calls: string[] = [];
  const api: GcpApi = {
    async listProjects() {
      return [];
    },
    async listBillingAccounts() {
      return [];
    },
    async createProject(projectId, name) {
      calls.push(`create:${projectId}:${name}`);
    },
    async attachBillingAccount(projectId, billingAccountName) {
      calls.push(`billing:${projectId}:${billingAccountName}`);
    },
  };

  await createProject("anmho-test", "test", api);
  await attachBillingAccount("anmho-test", "billingAccounts/123", api);

  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe("create:anmho-test:test");
  expect(calls[1]).toBe("billing:anmho-test:billingAccounts/123");
});
