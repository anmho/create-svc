type TemporalConfigInput = {
  enabled: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
  apiKeySecretName: string;
  vaultMount: string;
  vaultPath: string;
};

type TemporalProviderFields = {
  address?: string;
  namespace?: string;
  apiKey?: string;
};

export type TemporalRuntimeConfig = {
  enabled: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
  apiKeySecretName: string;
  apiKey: string;
};

export function resolveTemporalRuntimeConfigValues(
  config: TemporalConfigInput,
  env: Record<string, string | undefined>,
  readProviderFields: (mount: string, path: string) => TemporalProviderFields
): TemporalRuntimeConfig {
  const enabledOverride = env.TEMPORAL_ENABLED?.trim();
  const enabled = enabledOverride ? isTruthy(enabledOverride) : config.enabled;
  const taskQueue = env.TEMPORAL_TASK_QUEUE?.trim() || config.taskQueue;

  if (!enabled) {
    return {
      enabled: false,
      address: env.TEMPORAL_ADDRESS?.trim() || config.address,
      namespace: env.TEMPORAL_NAMESPACE?.trim() || config.namespace,
      taskQueue,
      apiKeySecretName: "",
      apiKey: "",
    };
  }

  const provider = readProviderFields(config.vaultMount, config.vaultPath);
  const address = env.TEMPORAL_ADDRESS?.trim() || provider.address || config.address;
  const namespace = env.TEMPORAL_NAMESPACE?.trim() || provider.namespace || config.namespace;
  const apiKey = env.TEMPORAL_API_KEY?.trim() || provider.apiKey || "";
  const apiKeySecretName = env.TEMPORAL_API_KEY_SECRET?.trim() || (apiKey ? config.apiKeySecretName : "");

  if (isLocalTemporalAddress(address)) {
    throw new Error(
      [
        "Temporal is enabled for this Cloud Run service, but the resolved Temporal address is local.",
        `Set TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and TEMPORAL_API_KEY, or populate Vault at ${config.vaultMount}/${config.vaultPath}`,
        "with TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and TEMPORAL_API_KEY before running service create or service deploy.",
        "Set TEMPORAL_ENABLED=false only for services that should deploy without Temporal.",
      ].join(" ")
    );
  }

  if (!namespace) {
    throw new Error(`Temporal is enabled but TEMPORAL_NAMESPACE is missing; set it in env or Vault at ${config.vaultMount}/${config.vaultPath}`);
  }

  return {
    enabled,
    address,
    namespace,
    taskQueue,
    apiKeySecretName,
    apiKey,
  };
}

function isTruthy(value: string) {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalTemporalAddress(address: string) {
  const value = address.trim().toLowerCase();
  return value === "" || value.startsWith("localhost:") || value.startsWith("127.0.0.1:") || value.startsWith("[::1]:");
}
