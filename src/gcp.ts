import { CloudBillingClient } from "@google-cloud/billing";
import { ProjectsClient } from "@google-cloud/resource-manager";

export type GcpProject = {
  projectId: string;
  name: string;
  lifecycleState?: string;
};

export type BillingAccount = {
  name: string;
  displayName: string;
  open: boolean;
};

export type GcpApi = {
  listProjects(): Promise<GcpProject[]>;
  listBillingAccounts(): Promise<BillingAccount[]>;
  createProject(projectId: string, name: string): Promise<void>;
  attachBillingAccount(projectId: string, billingAccountName: string): Promise<void>;
};

export function createGcpApi(
  projectsClient = new ProjectsClient(),
  billingClient = new CloudBillingClient()
): GcpApi {
  return {
    async listProjects() {
      const projects: GcpProject[] = [];
      for await (const project of projectsClient.searchProjectsAsync({}, { autoPaginate: false })) {
        projects.push({
          projectId: project.projectId ?? "",
          name: project.displayName ?? project.projectId ?? "",
          lifecycleState: `${project.state ?? ""}`,
        });
      }

      return projects
        .filter((project) => project.projectId && project.lifecycleState !== "DELETE_REQUESTED")
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async listBillingAccounts() {
      const accounts: BillingAccount[] = [];
      for await (const account of billingClient.listBillingAccountsAsync({}, { autoPaginate: false })) {
        accounts.push({
          name: account.name ?? "",
          displayName: account.displayName ?? account.name ?? "",
          open: Boolean(account.open),
        });
      }

      return accounts
        .filter((account) => account.name && account.open)
        .sort((left, right) => left.displayName.localeCompare(right.displayName));
    },

    async createProject(projectId: string, name: string) {
      const [operation] = await projectsClient.createProject({
        project: {
          projectId,
          displayName: name,
        },
      });
      await operation.promise();
    },

    async attachBillingAccount(projectId: string, billingAccountName: string) {
      await billingClient.updateProjectBillingInfo({
        name: `projects/${projectId}`,
        projectBillingInfo: {
          billingAccountName,
        },
      });
    },
  };
}

export async function listAccessibleProjects(api = createGcpApi()): Promise<GcpProject[]> {
  return (await api.listProjects())
    .filter((project) => project.projectId && project.lifecycleState !== "DELETE_REQUESTED")
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listOpenBillingAccounts(api = createGcpApi()): Promise<BillingAccount[]> {
  return (await api.listBillingAccounts())
    .filter((account) => account.name && account.open)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function createProject(projectId: string, name: string, api = createGcpApi()) {
  await api.createProject(projectId, name);
}

export async function attachBillingAccount(projectId: string, billingAccountName: string, api = createGcpApi()) {
  await api.attachBillingAccount(projectId, billingAccountName);
}
