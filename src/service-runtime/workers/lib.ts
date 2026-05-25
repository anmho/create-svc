import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export function resolveCommandPath(command: string, cwd = process.cwd()) {
  const local = join(cwd, "node_modules", ".bin", command);
  if (existsSync(local)) {
    return local;
  }
  return Bun.which(command);
}

export function isLocalDatabaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function isMissingDatabaseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /database ".+" does not exist/.test(message);
}

export function resolveWorkersProvisioningEnv(runtimeEnv: Record<string, string | undefined>, keys: {
  projectRefEnv: string;
  accessTokenEnv: string;
  secretKeyEnv: string;
}) {
  return createEnv({
    server: {
      [keys.projectRefEnv]: z.string().trim().min(1),
      [keys.accessTokenEnv]: z.string().trim().min(1),
      [keys.secretKeyEnv]: z.string().trim().min(1),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError: (issues) => {
      throw new Error(`Invalid environment variables: ${issues.map((issue) => issue.path?.join(".") || "unknown").join(", ")}`);
    },
  });
}
