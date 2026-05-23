import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const serviceRoot = process.env.CREATE_SVC_SERVICE_ROOT?.trim() || process.cwd();

export const serviceConfig = (
  await import(pathToFileURL(join(serviceRoot, "service.config.ts")).href)
).default;
