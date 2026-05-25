type TemporalConfigInput = {
  enabled: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
  apiKeySecretName: string;
  tlsCaCertSecretName?: string;
  tlsCertSecretName?: string;
  tlsKeySecretName?: string;
  vaultMount: string;
  vaultPath: string;
};

type TemporalProviderFields = {
  address?: string;
  namespace?: string;
  apiKey?: string;
  tlsCaCert?: string;
  tlsCert?: string;
  tlsKey?: string;
};

export type TemporalRuntimeConfig = {
  enabled: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
  apiKeySecretName: string;
  apiKey: string;
  tlsCaCertSecretName: string;
  tlsCertSecretName: string;
  tlsKeySecretName: string;
  tlsCaCert: string;
  tlsCert: string;
  tlsKey: string;
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
      tlsCaCertSecretName: "",
      tlsCertSecretName: "",
      tlsKeySecretName: "",
      tlsCaCert: "",
      tlsCert: "",
      tlsKey: "",
    };
  }

  const provider = readProviderFields(config.vaultMount, config.vaultPath);
  const address = env.TEMPORAL_ADDRESS?.trim() || provider.address || config.address;
  const namespace = env.TEMPORAL_NAMESPACE?.trim() || provider.namespace || config.namespace;
  const apiKey = env.TEMPORAL_API_KEY?.trim() || provider.apiKey || "";
  const apiKeySecretName = env.TEMPORAL_API_KEY_SECRET?.trim() || (apiKey ? config.apiKeySecretName : "");
  const tlsCaCert = env.TEMPORAL_TLS_CA_CERT?.trim() || provider.tlsCaCert || "";
  const tlsCert = env.TEMPORAL_TLS_CERT?.trim() || provider.tlsCert || "";
  const tlsKey = env.TEMPORAL_TLS_KEY?.trim() || provider.tlsKey || "";
  const tlsCaCertSecretName =
    env.TEMPORAL_TLS_CA_CERT_SECRET?.trim() || (tlsCaCert ? config.tlsCaCertSecretName || `${config.taskQueue}-temporal-ca-cert` : "");
  const tlsCertSecretName =
    env.TEMPORAL_TLS_CERT_SECRET?.trim() || (tlsCert ? config.tlsCertSecretName || `${config.taskQueue}-temporal-client-cert` : "");
  const tlsKeySecretName =
    env.TEMPORAL_TLS_KEY_SECRET?.trim() || (tlsKey ? config.tlsKeySecretName || `${config.taskQueue}-temporal-client-key` : "");

  if (isLocalTemporalAddress(address)) {
    throw new Error(
      [
        "Temporal is enabled for this Cloud Run service, but the resolved Temporal address is local.",
        `Set TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and TEMPORAL_API_KEY or TEMPORAL_TLS_* credentials, or populate Vault at ${config.vaultMount}/${config.vaultPath}`,
        "with TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and either TEMPORAL_API_KEY or TEMPORAL_TLS_CA_CERT/TEMPORAL_TLS_CERT/TEMPORAL_TLS_KEY before running service create or service deploy.",
        "Set TEMPORAL_ENABLED=false only for services that should deploy without Temporal.",
      ].join(" ")
    );
  }

  if (!namespace) {
    throw new Error(`Temporal is enabled but TEMPORAL_NAMESPACE is missing; set it in env or Vault at ${config.vaultMount}/${config.vaultPath}`);
  }
  if (!apiKey && (Boolean(tlsCaCert) || Boolean(tlsCert) || Boolean(tlsKey)) && (!tlsCaCert || !tlsCert || !tlsKey)) {
    throw new Error(
      `Temporal mTLS is partially configured; set TEMPORAL_TLS_CA_CERT, TEMPORAL_TLS_CERT, and TEMPORAL_TLS_KEY together in env or Vault at ${config.vaultMount}/${config.vaultPath}`
    );
  }
  if (!apiKey && !tlsCaCert) {
    throw new Error(
      `Temporal is enabled but no credentials were found; set TEMPORAL_API_KEY or TEMPORAL_TLS_CA_CERT/TEMPORAL_TLS_CERT/TEMPORAL_TLS_KEY in env or Vault at ${config.vaultMount}/${config.vaultPath}`
    );
  }

  return {
    enabled,
    address,
    namespace,
    taskQueue,
    apiKeySecretName,
    apiKey,
    tlsCaCertSecretName,
    tlsCertSecretName,
    tlsKeySecretName,
    tlsCaCert,
    tlsCert,
    tlsKey,
  };
}

function isTruthy(value: string) {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalTemporalAddress(address: string) {
  const value = address.trim().toLowerCase();
  return value === "" || value.startsWith("localhost:") || value.startsWith("127.0.0.1:") || value.startsWith("[::1]:");
}
