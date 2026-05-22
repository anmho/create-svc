import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export async function readLocalEnv() {
  if (!existsSync(".env.local")) {
    return {};
  }

  const values: Record<string, string> = {};
  const text = await readFile(".env.local", "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    values[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  return values;
}
