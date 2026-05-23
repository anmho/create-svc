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

export function createGcpApi(): GcpApi {
  return {
    async listProjects() {
      return parseJson<GcpProject[]>(
        runGcloud(["projects", "list", "--format=json(projectId,name,lifecycleState)"]).stdout,
        "GCP project discovery"
      );
    },

    async listBillingAccounts() {
      return parseJson<BillingAccount[]>(
        runGcloud(["billing", "accounts", "list", "--format=json(name,displayName,open)"]).stdout,
        "billing account discovery"
      );
    },

    async createProject(projectId: string, name: string) {
      runGcloud(["projects", "create", projectId, "--name", name]);
    },

    async attachBillingAccount(projectId: string, billingAccountName: string) {
      const account = billingAccountName.replace(/^billingAccounts\//, "");
      runGcloud(["billing", "projects", "link", projectId, "--billing-account", account]);
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

function runGcloud(args: string[]) {
  const result = Bun.spawnSync(["gcloud", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `gcloud ${args.join(" ")} failed`);
  }

  return {
    stdout: result.stdout.toString(),
  };
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Unable to parse ${label} output: ${(error as Error).message}`);
  }
}
