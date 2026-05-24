import { existsSync } from "node:fs";
import { join } from "node:path";

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
