import { resolveCloudRunTemporalEnv } from "./env";

export type TemporalRuntimeConfig = {
  enabled: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
};

type Env = Record<string, string | undefined>;

export function resolveTemporalRuntimeConfig(env: Env = Bun.env): TemporalRuntimeConfig {
  const parsed = resolveCloudRunTemporalEnv(env);

  return {
    enabled: parsed.TEMPORAL_ENABLED,
    address: parsed.TEMPORAL_ADDRESS ?? "",
    namespace: parsed.TEMPORAL_NAMESPACE ?? "",
    taskQueue: parsed.TEMPORAL_TASK_QUEUE,
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
