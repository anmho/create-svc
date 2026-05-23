import { join } from "node:path";
import { parseJsonc } from "../jsonc";

export const serviceRoot = process.env.CREATE_SVC_SERVICE_ROOT?.trim() || process.cwd();

export const serviceConfig = await readServiceConfig(serviceRoot);

async function readServiceConfig(root: string) {
  const configPath = join(root, "service.jsonc");
  const parsed = parseJsonc(await Bun.file(configPath).text());
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  return parsed as any;
}
