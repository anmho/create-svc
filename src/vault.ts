import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_VAULT_SECRET_MOUNT = "secret";
const DEFAULT_NEON_API_KEY_PATH = "prod/providers/neon";
const DEFAULT_NEON_API_KEY_FIELD = "api_key";

type VaultSecretOptions = {
  addr?: string;
  token?: string;
  mount?: string;
  path?: string;
  field?: string;
};

type VaultWriteOptions = {
  addr?: string;
  token?: string;
  mount?: string;
  path: string;
  fields: Record<string, string>;
};

export async function resolveNeonApiKey() {
  const direct = process.env.NEON_API_KEY?.trim();
  if (direct) {
    return direct;
  }

  return readVaultSecret({
    path: process.env.VAULT_NEON_API_KEY_PATH ?? DEFAULT_NEON_API_KEY_PATH,
    field: process.env.VAULT_NEON_API_KEY_FIELD ?? DEFAULT_NEON_API_KEY_FIELD,
  });
}

export async function readVaultSecret(options: VaultSecretOptions = {}) {
  const field = options.field?.trim() ?? "value";
  const payload = await readVaultSecretData(options);
  const mount = options.mount ?? process.env.VAULT_SECRET_MOUNT?.trim() ?? DEFAULT_VAULT_SECRET_MOUNT;
  const path = options.path?.trim() ?? "";
  const normalizedMount = mount.replace(/^\/+|\/+$/g, "");
  const normalizedPath = path.replace(/^\/+/g, "");
  const value = payload[field]?.trim();
  if (!value) {
    throw new Error(`Vault secret field ${field} is empty at ${normalizedMount}/${normalizedPath}`);
  }

  return value;
}

export async function readVaultSecretFields(options: VaultSecretOptions = {}) {
  return readVaultSecretData(options);
}

export async function upsertVaultSecretFields(options: VaultWriteOptions) {
  const connection = await resolveVaultConnection(options);
  const url = vaultKv2Url(connection);

  const existing = await readVaultSecretData({ ...options, path: connection.normalizedPath }).catch((error) => {
    if (error instanceof Error && error.message.startsWith("Vault read failed: 404")) {
      return {};
    }
    throw error;
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Token": connection.token,
    },
    body: JSON.stringify({
      data: {
        ...existing,
        ...trimFields(options.fields),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Vault write failed: ${response.status} ${response.statusText}`);
  }
}

async function readVaultSecretData(options: VaultSecretOptions = {}) {
  const connection = await resolveVaultConnection(options);
  const response = await fetch(vaultKv2Url(connection), {
    headers: {
      "X-Vault-Token": connection.token,
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

  return payload.data?.data ?? {};
}

async function resolveVaultConnection(options: Omit<VaultWriteOptions, "fields"> | VaultSecretOptions) {
  const addr = options.addr ?? process.env.VAULT_ADDR?.trim() ?? "";
  const token = options.token ?? (await resolveVaultToken());
  const mount = options.mount ?? process.env.VAULT_SECRET_MOUNT?.trim() ?? DEFAULT_VAULT_SECRET_MOUNT;
  const path = options.path?.trim() ?? "";

  if (!addr || !token || !path) {
    throw new Error("Vault secret resolution requires VAULT_ADDR, a Vault token, and a secret path");
  }

  const normalizedAddr = addr.replace(/\/+$/g, "");
  const normalizedMount = mount.replace(/^\/+|\/+$/g, "");
  const normalizedPath = path.replace(/^\/+/g, "");
  return { normalizedAddr, normalizedMount, normalizedPath, token };
}

function vaultKv2Url(connection: Awaited<ReturnType<typeof resolveVaultConnection>>) {
  return `${connection.normalizedAddr}/v1/${connection.normalizedMount}/data/${connection.normalizedPath}`;
}

function trimFields(fields: Record<string, string>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]));
}

async function resolveVaultToken() {
  const direct = process.env.VAULT_TOKEN?.trim();
  if (direct) {
    return direct;
  }

  const home = process.env.HOME?.trim() || homedir();
  const tokenFile = process.env.VAULT_TOKEN_FILE?.trim() || join(home, ".vault-token");

  try {
    const value = (await Bun.file(tokenFile).text()).trim();
    return value;
  } catch {
    return "";
  }
}
