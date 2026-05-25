import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

type RuntimeEnv = Record<string, string | undefined>;
type CloudRunEnv = {
  PORT: number;
  K_SERVICE?: string;
  DATABASE_URL: string;
  AUTH_ENABLED: boolean;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_JWKS_URL?: string;
  TEMPORAL_ENABLED: boolean;
  TEMPORAL_ADDRESS?: string;
  TEMPORAL_NAMESPACE?: string;
  TEMPORAL_TASK_QUEUE: string;
  TEMPORAL_API_KEY?: string;
};

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const temporalBooleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const optionalString = z.string().trim().min(1).optional();

function baseSchema() {
  return {
    PORT: z.coerce.number().int().min(0).default(8080),
    K_SERVICE: optionalString,
    DATABASE_URL: z.string().trim().min(1),
    AUTH_ENABLED: booleanString,
    AUTH_ISSUER: z.string().trim().url().optional(),
    AUTH_AUDIENCE: optionalString,
    AUTH_JWKS_URL: z.string().trim().url().optional(),
    TEMPORAL_ENABLED: temporalBooleanString,
    TEMPORAL_ADDRESS: optionalString,
    TEMPORAL_NAMESPACE: optionalString,
    TEMPORAL_TASK_QUEUE: optionalString.default("{{SERVICE_NAME}}"),
    TEMPORAL_API_KEY: optionalString,
  };
}

export function resolveCloudRunEnv(runtimeEnv: RuntimeEnv = Bun.env) {
  const env = createEnv({
    server: baseSchema(),
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError,
  }) as CloudRunEnv;

  return assertCloudRunEnv(env);
}

export function resolveCloudRunAuthEnv(runtimeEnv: RuntimeEnv = Bun.env) {
  const env = createEnv({
    server: {
      AUTH_ENABLED: booleanString,
      AUTH_ISSUER: z.string().trim().url().optional(),
      AUTH_AUDIENCE: optionalString,
      AUTH_JWKS_URL: z.string().trim().url().optional(),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError,
  }) as Pick<CloudRunEnv, "AUTH_ENABLED" | "AUTH_ISSUER" | "AUTH_AUDIENCE" | "AUTH_JWKS_URL">;

  return env;
}

export function resolveCloudRunTemporalEnv(runtimeEnv: RuntimeEnv = Bun.env) {
  const env = createEnv({
    server: {
      K_SERVICE: optionalString,
      TEMPORAL_ENABLED: temporalBooleanString,
      TEMPORAL_ADDRESS: optionalString,
      TEMPORAL_NAMESPACE: optionalString,
      TEMPORAL_TASK_QUEUE: optionalString.default("{{SERVICE_NAME}}"),
      TEMPORAL_API_KEY: optionalString,
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError,
  }) as Pick<
    CloudRunEnv,
    "K_SERVICE" | "TEMPORAL_ENABLED" | "TEMPORAL_ADDRESS" | "TEMPORAL_NAMESPACE" | "TEMPORAL_TASK_QUEUE" | "TEMPORAL_API_KEY"
  >;

  if (!env.K_SERVICE) {
    return {
      ...env,
      TEMPORAL_ADDRESS: env.TEMPORAL_ADDRESS ?? "localhost:7233",
      TEMPORAL_NAMESPACE: env.TEMPORAL_NAMESPACE ?? "default",
    };
  }

  return assertTemporalEnv(env);
}

function assertCloudRunEnv(env: CloudRunEnv) {
  const withTemporalDefaults = env.K_SERVICE
    ? env
    : {
        ...env,
        TEMPORAL_ADDRESS: env.TEMPORAL_ADDRESS ?? "localhost:7233",
        TEMPORAL_NAMESPACE: env.TEMPORAL_NAMESPACE ?? "default",
      };

  assertAuthEnv(withTemporalDefaults);
  assertTemporalEnv(withTemporalDefaults);
  return withTemporalDefaults;
}

function assertAuthEnv<T extends { AUTH_ENABLED: boolean; AUTH_ISSUER?: string; AUTH_AUDIENCE?: string; AUTH_JWKS_URL?: string }>(env: T) {
  if (!env.AUTH_ENABLED) {
    return env;
  }

  const missing = [
    env.AUTH_ISSUER ? "" : "AUTH_ISSUER",
    env.AUTH_AUDIENCE ? "" : "AUTH_AUDIENCE",
    env.AUTH_JWKS_URL ? "" : "AUTH_JWKS_URL",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`${formatList(missing)} ${missing.length === 1 ? "is" : "are"} required when AUTH_ENABLED=true`);
  }

  return env;
}

function assertTemporalEnv<
  T extends { TEMPORAL_ENABLED: boolean; TEMPORAL_ADDRESS?: string; TEMPORAL_NAMESPACE?: string; TEMPORAL_TASK_QUEUE?: string },
>(env: T) {
  if (!env.TEMPORAL_ENABLED) {
    return env;
  }

  const missing = [
    env.TEMPORAL_ADDRESS ? "" : "TEMPORAL_ADDRESS",
    env.TEMPORAL_NAMESPACE ? "" : "TEMPORAL_NAMESPACE",
    env.TEMPORAL_TASK_QUEUE ? "" : "TEMPORAL_TASK_QUEUE",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`${formatList(missing)} ${missing.length === 1 ? "is" : "are"} required when TEMPORAL_ENABLED=true`);
  }

  return env;
}

function onValidationError(issues: readonly any[]): never {
  throw new Error(`Invalid environment variables: ${issues.map((issue) => issue.path?.join(".") || "unknown").join(", ")}`);
}

function formatList(values: string[]) {
  if (values.length <= 2) {
    return values.join(" and ");
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
