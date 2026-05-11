import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import {
  addSecretVersion,
  ensureSecretAccessor,
  runtimeSecretNames,
  type DeploymentTarget,
} from "./lib";

type ProviderSecret = {
  envName: keyof ReturnType<typeof runtimeSecretNames>;
  provider: string;
  field: string;
};

const PROVIDER_SECRETS: ProviderSecret[] = [
  { envName: "CLERK_SECRET_KEY", provider: "clerk", field: "secret_key" },
  { envName: "CLERK_WEBHOOK_SECRET", provider: "clerk", field: "webhook_secret" },
  { envName: "STRIPE_SECRET_KEY", provider: "stripe", field: "secret_key" },
  { envName: "STRIPE_WEBHOOK_SECRET", provider: "stripe", field: "webhook_secret" },
  { envName: "REVENUECAT_API_KEY", provider: "revenuecat", field: "api_key" },
  { envName: "REVENUECAT_WEBHOOK_SECRET", provider: "revenuecat", field: "webhook_secret" },
  { envName: "RESEND_API_KEY", provider: "resend", field: "api_key" },
  { envName: "POSTHOG_API_KEY", provider: "posthog", field: "api_key" },
];

export async function publishProviderRuntimeSecrets(target: DeploymentTarget) {
  const secretNames = runtimeSecretNames(target);
  const missing: string[] = [];

  for (const secret of PROVIDER_SECRETS) {
    const value = await resolveProviderSecret(secret);
    if (!value) {
      missing.push(formatMissingSecret(secret));
      continue;
    }

    addSecretVersion(secretNames[secret.envName], value);
    ensureSecretAccessor(secretNames[secret.envName], `serviceAccount:${config.runtimeServiceAccount}`);
  }

  if (missing.length > 0) {
    throw new Error(
      [
        "Provider bootstrap credentials are required for the strict production bootstrap path.",
        "Set the missing environment variables or write the matching Vault fields, then rerun the same bootstrap/deploy command.",
        ...missing.map((item) => `- ${item}`),
      ].join("\n")
    );
  }
}

async function resolveProviderSecret(secret: ProviderSecret) {
  const direct = process.env[secret.envName]?.trim();
  if (direct) {
    return direct;
  }

  const addr = process.env.VAULT_ADDR?.trim() ?? "";
  const token = await resolveVaultToken();
  if (!addr || !token) {
    return "";
  }

  const mount = process.env.VAULT_SECRET_MOUNT?.trim() ?? "secret";
  const path = providerVaultPath(secret.provider);
  const normalizedAddr = addr.replace(/\/+$/g, "");
  const normalizedMount = mount.replace(/^\/+|\/+$/g, "");
  const response = await fetch(`${normalizedAddr}/v1/${normalizedMount}/data/${path}`, {
    headers: {
      "X-Vault-Token": token,
    },
  });

  if (!response.ok) {
    return "";
  }

  const payload = (await response.json()) as {
    data?: {
      data?: Record<string, string | undefined>;
    };
  };

  return payload.data?.data?.[secret.field]?.trim() ?? "";
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

function providerVaultPath(provider: string) {
  const override = process.env[`VAULT_${provider.toUpperCase()}_PATH`]?.trim();
  return (override || `prod/providers/${provider}`).replace(/^\/+/g, "");
}

function formatMissingSecret(secret: ProviderSecret) {
  return `${secret.envName} or Vault secret/${providerVaultPath(secret.provider)} field ${secret.field}`;
}
