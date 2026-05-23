import { createApiClient } from "@neondatabase/api-client";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

type NeonProject = {
  id: string;
  name: string;
};

type NeonBranch = {
  id: string;
  name: string;
};

type NeonDatabase = {
  name: string;
  ownerName: string;
};

type ResolvedNeonConfig = {
  projectId: string;
  baseBranchId: string;
  baseBranchName: string;
  databaseName: string;
  roleName: string;
  previewBranchPrefix: string;
  personalBranchPrefix: string;
};

async function resolveNeonApiKey() {
  const direct = process.env.NEON_API_KEY?.trim();
  if (direct) {
    return direct;
  }

  const addr = process.env.VAULT_ADDR?.trim() ?? "";
  const token = await resolveVaultToken();
  const mount = process.env.VAULT_SECRET_MOUNT?.trim() ?? "secret";
  const path = process.env.VAULT_NEON_API_KEY_PATH?.trim() ?? "prod/providers/neon";
  const field = process.env.VAULT_NEON_API_KEY_FIELD?.trim() ?? "api_key";

  if (!addr || !token) {
    throw new Error("NEON_API_KEY is required for Neon provisioning, or set VAULT_ADDR with VAULT_TOKEN, VAULT_TOKEN_FILE, or ~/.vault-token");
  }

  const normalizedAddr = addr.replace(/\/+$/g, "");
  const normalizedMount = mount.replace(/^\/+|\/+$/g, "");
  const normalizedPath = path.replace(/^\/+/g, "");
  const response = await fetch(`${normalizedAddr}/v1/${normalizedMount}/data/${normalizedPath}`, {
    headers: {
      "X-Vault-Token": token,
    },
  });

  if (!response.ok) {
    throw new Error(`Vault read failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    data?: {
      data?: Record<string, string | undefined>;
    };
  };

  const apiKey = payload.data?.data?.[field]?.trim();
  if (!apiKey) {
    throw new Error(`Vault secret field ${field} is empty at ${normalizedMount}/${normalizedPath}`);
  }

  return apiKey;
}

async function resolveVaultToken() {
  const direct = process.env.VAULT_TOKEN?.trim();
  if (direct) {
    return direct;
  }

  const tokenFile = process.env.VAULT_TOKEN_FILE?.trim() || join(process.env.HOME?.trim() || homedir(), ".vault-token");

  try {
    return (await Bun.file(tokenFile).text()).trim();
  } catch {
    return "";
  }
}

async function neonClient() {
  const apiKey = await resolveNeonApiKey();
  return createApiClient({ apiKey });
}

export async function listProjects() {
  const payload = await (await neonClient()).listProjects({ limit: 100 });
  const projects = ((payload.data as { projects?: Array<{ id?: string; name?: string }> } | undefined)?.projects ?? []);
  return projects
    .map((project: { id?: string; name?: string }) => ({
      id: project.id ?? "",
      name: project.name ?? project.id ?? "",
    }))
    .filter((project: NeonProject): project is NeonProject => Boolean(project.id))
    .sort((left: NeonProject, right: NeonProject) => left.name.localeCompare(right.name));
}

export async function listBranches(projectId: string) {
  const payload = await (await neonClient()).listProjectBranches({ projectId });
  const branches = ((payload.data as { branches?: Array<{ id?: string; name?: string }> } | undefined)?.branches ?? []);
  return branches
    .map((branch: { id?: string; name?: string }) => ({
      id: branch.id ?? "",
      name: branch.name ?? branch.id ?? "",
    }))
    .filter((branch: NeonBranch): branch is NeonBranch => Boolean(branch.id))
    .sort((left: NeonBranch, right: NeonBranch) => left.name.localeCompare(right.name));
}

export async function listDatabases(projectId: string, branchId: string) {
  const payload = await (await neonClient()).listProjectBranchDatabases(projectId, branchId);
  const databases = ((payload.data as { databases?: Array<{ name?: string; owner_name?: string }> } | undefined)?.databases ?? []);
  return databases
    .map((database: { name?: string; owner_name?: string }) => ({
      name: database.name ?? "",
      ownerName: database.owner_name ?? "",
    }))
    .filter((database: NeonDatabase): database is NeonDatabase => Boolean(database.name))
    .sort((left: NeonDatabase, right: NeonDatabase) => left.name.localeCompare(right.name));
}

export async function resolveNeonConfig(): Promise<ResolvedNeonConfig> {
  const configuredProjectId = config.neon.projectId.trim();
  const configuredBaseBranchId = config.neon.baseBranchId.trim();
  const configuredBaseBranchName = config.neon.baseBranchName.trim() || "main";

  if (configuredProjectId && configuredBaseBranchId) {
    return {
      projectId: configuredProjectId,
      baseBranchId: configuredBaseBranchId,
      baseBranchName: configuredBaseBranchName,
      databaseName: config.neon.databaseName,
      roleName: config.neon.roleName,
      previewBranchPrefix: config.neon.previewBranchPrefix,
      personalBranchPrefix: config.neon.personalBranchPrefix,
    };
  }

  const projects = await listProjects();
  const project = projects[0];
  if (!project) {
    throw new Error(`No Neon projects are available for ${config.serviceName}`);
  }

  const branches = await listBranches(project.id);
  const branch = branches.find((candidate) => candidate.name === configuredBaseBranchName) ?? branches[0];
  if (!branch) {
    throw new Error(`No Neon branches are available in project ${project.id}`);
  }

  return {
    projectId: project.id,
    baseBranchId: branch.id,
    baseBranchName: branch.name,
    databaseName: config.neon.databaseName,
    roleName: config.neon.roleName,
    previewBranchPrefix: config.neon.previewBranchPrefix,
    personalBranchPrefix: config.neon.personalBranchPrefix,
  };
}

export async function ensureDatabase(projectId: string, branchId: string, databaseName: string) {
  const client = await neonClient();

  try {
    await client.getProjectBranchDatabase(projectId, branchId, databaseName);
    return;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 404) {
      throw error;
    }
  }

  await client.createProjectBranchDatabase(projectId, branchId, {
    database: {
      name: databaseName,
      owner_name: config.neon.roleName,
    },
  });
}

export async function deleteDatabase(projectId: string, branchId: string, databaseName: string) {
  await assertDatabaseOwned(projectId, branchId, databaseName);
  try {
    await (await neonClient()).deleteProjectBranchDatabase(projectId, branchId, databaseName);
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return;
    }
    throw error;
  }
}

export async function ensureBranch(projectId: string, branchName: string, parentId: string) {
  const existing = (await listBranches(projectId)).find((branch) => branch.name === branchName);
  if (existing) {
    return existing;
  }

  const payload = await (await neonClient()).createProjectBranch(projectId, {
    branch: {
      name: branchName,
      parent_id: parentId,
    },
    endpoints: [
      {
        type: "read_write" as never,
      },
    ],
  });

  const branch = (payload.data as { branch?: { id?: string; name?: string } } | undefined)?.branch;
  if (!branch?.id) {
    throw new Error(`Neon did not return a branch for ${branchName}`);
  }

  return {
    id: branch.id,
    name: branch.name ?? branch.id,
  };
}

export async function deleteBranch(projectId: string, branchId: string) {
  const branch = (await listBranches(projectId)).find((candidate) => candidate.id === branchId);
  if (!branch) {
    return;
  }
  assertDisposableBranchName(branch.name);
  try {
    await (await neonClient()).deleteProjectBranch(projectId, branchId);
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return;
    }
    throw error;
  }
}

async function assertDatabaseOwned(projectId: string, branchId: string, databaseName: string) {
  if (databaseName !== config.neon.databaseName) {
    throw new Error(`Refusing to delete Neon database ${databaseName}; expected ${config.neon.databaseName}`);
  }

  const database = (await listDatabases(projectId, branchId)).find((candidate) => candidate.name === databaseName);
  if (!database) {
    return;
  }

  if (database.ownerName && database.ownerName !== config.neon.roleName) {
    throw new Error(`Refusing to delete Neon database ${databaseName}; owner is ${database.ownerName}, expected ${config.neon.roleName}`);
  }
}

function assertDisposableBranchName(branchName: string) {
  if (branchName.startsWith(`${config.neon.previewBranchPrefix}-`) || branchName.startsWith(`${config.neon.personalBranchPrefix}-`)) {
    return;
  }
  throw new Error(`Refusing to delete Neon branch ${branchName}; it is not owned by ${config.serviceName}`);
}

export async function getConnectionUri(projectId: string, branchId: string, databaseName: string, roleName: string) {
  const payload = await (await neonClient()).getConnectionUri({
    projectId,
    branch_id: branchId,
    database_name: databaseName,
    role_name: roleName,
  });

  const uri = (payload.data as { uri?: string } | undefined)?.uri;
  if (!uri) {
    throw new Error(`Neon did not return a connection URI for ${databaseName} in ${config.serviceName}`);
  }

  return uri;
}
