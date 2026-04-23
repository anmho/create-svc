import { log } from "@clack/prompts";
import { config, githubVariables } from "./config";
import { deleteBranch, deleteDatabase, listBranches } from "./neon";
import {
  deleteGithubRepository,
  deleteGithubVariable,
  deleteProject,
  deleteSecret,
  deleteService,
  deleteServiceAccount,
  deleteWorkloadIdentityProvider,
  listCloudRunServices,
  listSecrets,
  parseCleanupArgs,
  requireCommand,
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

  const options = parseCleanupArgs(args);

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

  if (config.neon.projectId && config.neon.baseBranchId) {
    const branches = await runStep("Finding Neon branches", () => listBranches(config.neon.projectId));
    const disposableBranches = branches.filter(
      (branch) => branch.name.startsWith(`${config.neon.previewBranchPrefix}-`) || branch.name.startsWith(`${config.neon.personalBranchPrefix}-`)
    );

    await runStep("Deleting Neon preview and personal branches", async () => {
      for (const branch of disposableBranches) {
        await deleteBranch(config.neon.projectId, branch.id);
      }
    });

    await runStep("Deleting Neon service database", () =>
      deleteDatabase(config.neon.projectId, config.neon.baseBranchId, config.neon.databaseName)
    );
  } else {
    log.step("Skipping Neon cleanup because Neon is not configured");
  }

  await runStep("Deleting service-specific identity resources", () => {
    deleteWorkloadIdentityProvider();
    deleteServiceAccount(config.runtimeServiceAccount);
    deleteServiceAccount(config.deployerServiceAccount);
  });

  if (Bun.which("gh")) {
    await runStep("Deleting GitHub repository variables", () => {
      for (const name of [...Object.keys(githubVariables), "GCP_WIF_PROVIDER", "GCP_DEPLOYER_SERVICE_ACCOUNT"]) {
        deleteGithubVariable(name);
      }
    });

    if (options.destroyRepo) {
      await runStep(`Deleting GitHub repository ${config.github.repo}`, () => deleteGithubRepository());
    }
  } else if (options.destroyRepo) {
    throw new Error("gh is required to delete the GitHub repository");
  } else {
    log.step("Skipping GitHub cleanup because gh is not installed");
  }

  if (options.destroyProject) {
    await runStep(`Deleting GCP project ${config.project.id}`, () => deleteProject());
    return `Deleted project ${config.project.id}`;
  }

  return `Cleanup finished for ${config.serviceName}`;
}

if (import.meta.main) {
  await runMain("Cleanup", () => cleanup(Bun.argv.slice(2)));
}
