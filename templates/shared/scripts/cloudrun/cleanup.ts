import { confirm, isCancel, log } from "@clack/prompts";
import { config } from "./config";
import { deleteBranch, deleteDatabase, listBranches, resolveNeonConfig } from "./neon";
import {
  assertOwnedResource,
  deleteProject,
  deleteProductionDomainMapping,
  deleteSecret,
  deleteService,
  deleteServiceAccount,
  describeCloudRunService,
  describeProductionDomainMapping,
  describeSecret,
  listCloudRunServices,
  listSecrets,
  parseCleanupArgs,
  requireCommand,
  requireGcloudAuth,
  run,
  runMain,
  runStep,
} from "./lib";

function matchesServiceResource(name: string) {
  return name === config.serviceName || name.startsWith(`${config.serviceName}-pr-`) || name.startsWith(`${config.serviceName}-dev-`);
}

function matchesSecretResource(name: string) {
  return (
    name === `${config.serviceName}-database-url` ||
    name === config.temporal.apiKeySecretName ||
    name.startsWith(`${config.serviceName}-pr-`) ||
    name.startsWith(`${config.serviceName}-dev-`)
  );
}

export async function cleanup(args = Bun.argv.slice(2)) {
  requireCommand("gcloud");
  requireGcloudAuth();

  const options = parseCleanupArgs(args);
  await requireDestroyConfirmation(options.force);

  await runStep(`Verifying production domain mapping ${config.domain.hostname}`, () => assertProductionDomainMappingOwned());
  await runStep(`Deleting production domain mapping ${config.domain.hostname}`, () => deleteProductionDomainMapping());

  const services = await runStep("Finding Cloud Run services", () => listCloudRunServices());
  const serviceNames = services.filter(matchesServiceResource);
  await runStep("Deleting Cloud Run services", () => {
    for (const serviceName of serviceNames) {
      assertOwnedResource(`Cloud Run service ${serviceName}`, describeCloudRunService(serviceName));
      deleteService(serviceName);
    }
  });

  const secrets = await runStep("Finding service secrets", () => listSecrets());
  const secretNames = secrets.filter(matchesSecretResource);
  await runStep("Deleting service secrets", () => {
    for (const secretName of secretNames) {
      assertOwnedResource(`Secret ${secretName}`, describeSecret(secretName));
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

  await runStep("Deleting Grafana resources", async () => deleteGrafanaResources());

  await runStep("Deleting service-specific identity resources", () => {
    deleteServiceAccount(config.runtimeServiceAccount);
  });

  if (options.destroyProject) {
    await runStep(`Deleting GCP project ${config.project.id}`, () => deleteProject());
    return `Deleted project ${config.project.id}`;
  }

  log.step(`Production API hostname released: ${config.domain.hostname}`);
  return `Destroy finished for ${config.serviceName}`;
}

async function deleteGrafanaResources() {
  if (!(await Bun.file("./grafana").exists())) {
    return "No grafana directory configured";
  }
  if (!Bun.which("gcx")) {
    return "gcx is not installed; Grafana resources were not deleted";
  }

  run("gcx", ["resources", "delete", "--path", "./grafana", "--yes", "--on-error", "ignore"]);
  return "Grafana resources deleted from local manifests";
}

function assertProductionDomainMappingOwned() {
  const mapping = describeProductionDomainMapping();
  if (!mapping) {
    return;
  }

  const routeName = mapping.spec?.routeName;
  if (routeName !== config.serviceName) {
    throw new Error(`${config.domain.hostname} maps to ${routeName || "an unknown service"}; refusing to delete ambiguous DNS mapping`);
  }

  assertOwnedResource(`Cloud Run service ${routeName}`, describeCloudRunService(routeName));
}

async function requireDestroyConfirmation(force: boolean) {
  if (force) {
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error("service destroy requires --force when running non-interactively");
  }

  const answer = await confirm({
    message: `Destroy resources owned by ${config.serviceName}?`,
    initialValue: false,
  });
  if (isCancel(answer) || !answer) {
    throw new Error("Destroy cancelled");
  }
}

if (import.meta.main) {
  await runMain("Destroy", () => cleanup(Bun.argv.slice(2)));
}
