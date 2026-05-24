export type GcpProject = {
  projectId: string;
  name?: string;
  lifecycleState?: string;
};

export type BillingAccount = {
  name: string;
  displayName: string;
  open: boolean;
};

export type BillingProject = {
  billingEnabled?: boolean;
  billingAccountName?: string;
};

export type GcpApi = {
  listProjects(): Promise<GcpProject[]>;
  listBillingAccounts(): Promise<BillingAccount[]>;
  describeProject?(projectId: string): Promise<GcpProject>;
  describeBillingProject?(projectId: string): Promise<BillingProject>;
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

    async describeProject(projectId: string) {
      return parseJson<GcpProject>(
        runGcloud(["projects", "describe", projectId, "--format=json(projectId,name,lifecycleState)"]).stdout,
        "GCP project"
      );
    },

    async describeBillingProject(projectId: string) {
      return parseJson<BillingProject>(
        runGcloud(["beta", "billing", "projects", "describe", projectId, "--format=json(billingEnabled,billingAccountName)"]).stdout,
        "GCP project billing"
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
    .sort((left, right) => projectSortName(left).localeCompare(projectSortName(right)));
}

export async function listOpenBillingAccounts(api = createGcpApi()): Promise<BillingAccount[]> {
  return (await api.listBillingAccounts())
    .filter((account) => account.name && account.open)
    .sort((left, right) => accountSortName(left).localeCompare(accountSortName(right)));
}

export async function createProject(projectId: string, name: string, api = createGcpApi()) {
  await api.createProject(projectId, name);
}

export async function attachBillingAccount(projectId: string, billingAccountName: string, api = createGcpApi()) {
  await api.attachBillingAccount(projectId, billingAccountName);
}

export async function assertExistingProjectReadyForAutoDeploy(projectId: string, api = createGcpApi()) {
  try {
    await api.describeProject?.(projectId);
  } catch (error) {
    throw new Error(
      [
        `GCP project ${projectId} does not exist or is not accessible.`,
        "Create and enable billing on that project before one-shot create, pass --project-id <billed-project>, or pass --no-auto-deploy.",
        formatErrorDetail(error),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  let billing: BillingProject;
  try {
    billing = (await api.describeBillingProject?.(projectId)) ?? {};
  } catch (error) {
    throw new Error(
      [
        `Unable to verify billing for GCP project ${projectId}.`,
        "Fix billing access before one-shot create, pass --project-id <billed-project>, or pass --no-auto-deploy.",
        formatErrorDetail(error),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (!billing.billingEnabled) {
    throw new Error(
      [
        `GCP project ${projectId} exists but billing is not enabled.`,
        "Link billing before one-shot create, pass --project-id <billed-project>, or pass --no-auto-deploy.",
      ].join("\n")
    );
  }
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

function projectSortName(project: GcpProject) {
  return project.name || project.projectId;
}

function accountSortName(account: BillingAccount) {
  return account.displayName || account.name;
}

function formatErrorDetail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message ? `Details: ${message}` : undefined;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Unable to parse ${label} output: ${(error as Error).message}`);
  }
}
