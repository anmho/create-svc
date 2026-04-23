import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_VAULT_SECRET_MOUNT = "secret";
const DEFAULT_NEON_API_KEY_PATH = "provider/neon-api-key";
const DEFAULT_NEON_API_KEY_FIELD = "value";

type VaultSecretOptions = {
  addr?: string;
  token?: string;
  mount?: string;
  path?: string;
  field?: string;
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
  const addr = options.addr ?? process.env.VAULT_ADDR?.trim() ?? "";
  const token = options.token ?? (await resolveVaultToken());
  const mount = options.mount ?? process.env.VAULT_SECRET_MOUNT?.trim() ?? DEFAULT_VAULT_SECRET_MOUNT;
  const path = options.path?.trim() ?? "";
  const field = options.field?.trim() ?? "value";

  if (!addr || !token || !path) {
    throw new Error("Vault secret resolution requires VAULT_ADDR, a Vault token, and a secret path");
  }

  const normalizedAddr = addr.replace(/\/+$/g, "");
  const normalizedMount = mount.replace(/^\/+|\/+$/g, "");
  const normalizedPath = path.replace(/^\/+/g, "");
  const url = `${normalizedAddr}/v1/${normalizedMount}/data/${normalizedPath}`;

  const response = await fetch(url, {
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

  const value = payload.data?.data?.[field]?.trim();
  if (!value) {
    throw new Error(`Vault secret field ${field} is empty at ${normalizedMount}/${normalizedPath}`);
  }

  return value;
}

async function resolveVaultToken() {
  const direct = process.env.VAULT_TOKEN?.trim();
  if (direct) {
    return direct;
  }

  const tokenFile = process.env.VAULT_TOKEN_FILE?.trim() || join(homedir(), ".vault-token");

  try {
    const value = (await Bun.file(tokenFile).text()).trim();
    return value;
  } catch {
    return "";
  }
}
