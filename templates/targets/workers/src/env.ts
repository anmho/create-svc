import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export type WorkersBindings = {
  HYPERDRIVE?: any;
  AUTH_ENABLED?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_JWKS_URL?: string;
  TRIGGER_SECRET_KEY?: string;
  TRIGGER_TASK_ID?: string;
  TRIGGER_API_URL?: string;
  [key: string]: unknown;
};

type RuntimeEnv = Record<string, string | undefined>;

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalString = z.string().trim().min(1).optional();
const requiredString = z.string().trim().min(1);

export function resolveWorkersRuntimeEnv(runtimeEnv: WorkersBindings = {}) {
  const env = createEnv({
    server: {
      AUTH_ENABLED: booleanString,
      AUTH_ISSUER: z.string().trim().url().optional(),
      AUTH_AUDIENCE: optionalString,
      AUTH_JWKS_URL: z.string().trim().url().optional(),
      TRIGGER_SECRET_KEY: optionalString,
      TRIGGER_TASK_ID: optionalString.default("{{SERVICE_ID}}-waitlist-follow-up"),
      TRIGGER_API_URL: z.string().trim().url().default("https://api.trigger.dev"),
    },
    runtimeEnv: runtimeEnv as Record<string, string | undefined>,
    emptyStringAsUndefined: true,
    onValidationError,
  });

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

export function resolveWorkersTriggerEnv(runtimeEnv: WorkersBindings = {}) {
  const env = resolveWorkersRuntimeEnv(runtimeEnv);
  if (!env.TRIGGER_SECRET_KEY) {
    throw new Error("TRIGGER_SECRET_KEY is required to dispatch Trigger.dev tasks");
  }
  return env;
}

export function resolveWorkersProvisioningEnv(runtimeEnv: RuntimeEnv = Bun.env) {
  return createEnv({
    server: {
      TRIGGER_PROJECT_REF: requiredString,
      TRIGGER_ACCESS_TOKEN: requiredString,
      TRIGGER_SECRET_KEY: requiredString,
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError,
  });
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
