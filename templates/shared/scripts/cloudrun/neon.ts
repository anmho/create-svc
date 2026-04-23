import { createApiClient } from "@neondatabase/api-client";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

type NeonBranch = {
  id: string;
  name: string;
};

async function resolveNeonApiKey() {
  const direct = process.env.NEON_API_KEY?.trim();
  if (direct) {
    return direct;
  }

  const addr = process.env.VAULT_ADDR?.trim() ?? "";
  const token = await resolveVaultToken();
  const mount = process.env.VAULT_SECRET_MOUNT?.trim() ?? "secret";
  const path = process.env.VAULT_NEON_API_KEY_PATH?.trim() ?? "provider/neon-api-key";
  const field = process.env.VAULT_NEON_API_KEY_FIELD?.trim() ?? "value";

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

  const tokenFile = process.env.VAULT_TOKEN_FILE?.trim() || join(homedir(), ".vault-token");

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

export async function listBranches(projectId: string) {
  const payload = await (await neonClient()).listProjectBranches({ projectId });
  return (payload.branches ?? [])
    .map((branch) => ({
      id: branch.id ?? "",
      name: branch.name ?? branch.id ?? "",
    }))
    .filter((branch): branch is NeonBranch => Boolean(branch.id))
    .sort((left, right) => left.name.localeCompare(right.name));
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
    },
  });
}

export async function deleteDatabase(projectId: string, branchId: string, databaseName: string) {
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
        type: "read_write",
      },
    ],
  });

  const branch = payload.branch;
  if (!branch?.id) {
    throw new Error(`Neon did not return a branch for ${branchName}`);
  }

  return {
    id: branch.id,
    name: branch.name ?? branch.id,
  };
}

export async function deleteBranch(projectId: string, branchId: string) {
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

export async function getConnectionUri(projectId: string, branchId: string, databaseName: string, roleName: string) {
  const payload = await (await neonClient()).getConnectionUri({
    projectId,
    branchId,
    databaseName,
    roleName,
  });

  const uri = payload.uri;
  if (!uri) {
    throw new Error(`Neon did not return a connection URI for ${databaseName} in ${config.serviceName}`);
  }

  return uri;
}
