import { log } from "@clack/prompts";
import { config } from "./config";
import { deleteBranch, deleteDatabase, listBranches, resolveNeonConfig } from "./neon";
import {
  deleteProject,
  deleteProductionDomainMapping,
  deleteSecret,
  deleteService,
  deleteServiceAccount,
  listCloudRunServices,
  listSecrets,
  parseCleanupArgs,
  requireCommand,
  requireGcloudAuth,
  runMain,
  runStep,
} from "./lib";

function matchesServiceResource(name: string) {
  return name === config.serviceName || name.startsWith(`${config.serviceName}-pr-`) || name.startsWith(`${config.serviceName}-dev-`);
}

function matchesSecretResource(name: string) {
  return name === `${config.serviceName}-database-url` || name.startsWith(`${config.serviceName}-pr-`) || name.startsWith(`${config.serviceName}-dev-`);
}

export async function cleanup(args = Bun.argv.slice(2)) {
  requireCommand("gcloud");
  requireGcloudAuth();

  const options = parseCleanupArgs(args);

  await runStep(`Deleting production domain mapping ${config.domain.hostname}`, () => deleteProductionDomainMapping());

  const services = await runStep("Finding Cloud Run services", () => listCloudRunServices());
  const serviceNames = services.filter(matchesServiceResource);
  await runStep("Deleting Cloud Run services", () => {
    for (const serviceName of serviceNames) {
      deleteService(serviceName);
    }
  });

  const secrets = await runStep("Finding service secrets", () => listSecrets());
  const secretNames = secrets.filter(matchesSecretResource);
  await runStep("Deleting service secrets", () => {
    for (const secretName of secretNames) {
      deleteSecret(secretName);
    }
  });

  try {
    const neon = await runStep("Resolving Neon defaults", () => resolveNeonConfig());
    const branches = await runStep("Finding Neon branches", () => listBranches(neon.projectId));
    const disposableBranches = branches.filter(
      (branch: { name: string }) =>
        branch.name.startsWith(`${neon.previewBranchPrefix}-`) || branch.name.startsWith(`${neon.personalBranchPrefix}-`)
    );

    await runStep("Deleting Neon preview and personal branches", async () => {
      for (const branch of disposableBranches) {
        await deleteBranch(neon.projectId, branch.id);
      }
    });

    await runStep("Deleting Neon service database", () => deleteDatabase(neon.projectId, neon.baseBranchId, neon.databaseName));
  } catch (error) {
    log.step("Skipping Neon cleanup because Neon is not configured");
    log.step(error instanceof Error ? error.message : String(error));
  }

  await runStep("Deleting service-specific identity resources", () => {
    deleteServiceAccount(config.runtimeServiceAccount);
  });

  if (options.destroyProject) {
    await runStep(`Deleting GCP project ${config.project.id}`, () => deleteProject());
    return `Deleted project ${config.project.id}`;
  }

  log.step(`Production API hostname released: ${config.domain.hostname}`);
  return `Cleanup finished for ${config.serviceName}`;
}

if (import.meta.main) {
  await runMain("Cleanup", () => cleanup(Bun.argv.slice(2)));
}
