export type TemporalRuntimeConfig = {
  enabled: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
};

type Env = Record<string, string | undefined>;

export function resolveTemporalRuntimeConfig(env: Env = Bun.env): TemporalRuntimeConfig {
  const enabled = readBoolean(env.TEMPORAL_ENABLED, true);
  const cloudRun = isCloudRun(env);

  return {
    enabled,
    address: readString(env.TEMPORAL_ADDRESS, cloudRun ? "" : "localhost:7233"),
    namespace: readString(env.TEMPORAL_NAMESPACE, cloudRun ? "" : "default"),
    taskQueue: readString(env.TEMPORAL_TASK_QUEUE, "{{SERVICE_NAME}}"),
  };
}

export function assertTemporalRuntimeConfig(config = resolveTemporalRuntimeConfig()) {
  if (!config.enabled) {
    return config;
  }

  const missing = [
    config.address ? "" : "TEMPORAL_ADDRESS",
    config.namespace ? "" : "TEMPORAL_NAMESPACE",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Temporal is enabled, but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} required. Set Temporal Cloud connection settings or TEMPORAL_ENABLED=false.`
    );
  }

  return config;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(normalized);
}

function readString(value: string | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized || fallback;
}

function isCloudRun(env: Env) {
  return Boolean(env.K_SERVICE?.trim());
}
