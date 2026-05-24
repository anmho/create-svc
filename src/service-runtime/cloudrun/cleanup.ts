import { confirm, isCancel, log } from "@clack/prompts";
import { deleteAuthResourceServer } from "../authctl";
import { buildLocalDevCleanupPlan, stopLocalDev } from "../local-dev";
import { config } from "./config";
import { deleteBranch, deleteDatabase, listBranches, resolveNeonConfig } from "./neon";
import {
  assertOwnedResource,
  deleteArtifactImage,
  deleteProject,
  deleteProductionDomainMapping,
  deleteSecret,
  deleteService,
  deleteServiceAccount,
  describeCloudRunService,
  describeProductionDomainMapping,
  describeSecret,
  formatError,
  listCloudRunServices,
  listArtifactImages,
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

type PlannedResource = {
  label: string;
  detail?: string;
};

type DestroyPlan = {
  resources: PlannedResource[];
  skipped: PlannedResource[];
  blockers: string[];
  githubRepository?: string;
  hasProductionDomainMapping: boolean;
  serviceNames: string[];
  secretNames: string[];
  artifactImages: string[];
  neon?: {
    projectId: string;
    baseBranchId: string;
    databaseName: string;
    branches: Array<{ id: string; name: string }>;
  };
};

export async function cleanup(args = Bun.argv.slice(2)) {
  requireCommand("gcloud");
  requireGcloudAuth();

  const options = parseCleanupArgs(args);
  const plan = await runStep("Planning resources to destroy", () => buildDestroyPlan(options.destroyProject));
  printDestroyPlan(plan);
  if (plan.blockers.length > 0) {
    throw new Error(["Destroy cannot continue until resource discovery succeeds:", ...plan.blockers.map((blocker) => `- ${blocker}`)].join("\n"));
  }

  await requireDestroyConfirmation(options.force);

  await runStep("Stopping local dev resources", () => stopLocalDev({ dockerCompose: true, removeVolumes: true }));

  if (plan.githubRepository) {
    await runStep(`Deleting GitHub repository ${plan.githubRepository}`, () => deleteGitHubRepository(plan.githubRepository!));
  }

  await runStep(`Deleting auth resource server ${config.serviceName}`, () => deleteAuthResourceServer());

  if (plan.hasProductionDomainMapping) {
    await runStep(`Deleting production domain mapping ${config.domain.hostname}`, () => deleteProductionDomainMapping());
  }

  const serviceNames = plan.serviceNames;
  await runStep("Deleting Cloud Run services", () => {
    for (const serviceName of serviceNames) {
      assertOwnedResource(`Cloud Run service ${serviceName}`, describeCloudRunService(serviceName));
      deleteService(serviceName);
    }
  });

  const artifactImages = plan.artifactImages;
  await runStep("Deleting Artifact Registry images", () => {
    for (const image of artifactImages) {
      deleteArtifactImage(image);
    }
  });

  const secretNames = plan.secretNames;
  await runStep("Deleting service secrets", () => {
    for (const secretName of secretNames) {
      assertOwnedResource(`Secret ${secretName}`, describeSecret(secretName));
      deleteSecret(secretName);
    }
  });

  const neonPlan = plan.neon;
  if (neonPlan) {
    await runStep("Deleting Neon preview and personal branches", async () => {
      for (const branch of neonPlan.branches) {
        await deleteBranch(neonPlan.projectId, branch.id);
      }
    });

    await runStep("Deleting Neon service database", () => deleteDatabase(neonPlan.projectId, neonPlan.baseBranchId, neonPlan.databaseName));
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

async function buildDestroyPlan(destroyProject: boolean): Promise<DestroyPlan> {
  const plan: DestroyPlan = {
    resources: [
      { label: `Auth resource server ${config.serviceName}`, detail: "stage prod" },
      { label: `Runtime service account ${config.runtimeServiceAccount}`, detail: "if it exists" },
    ],
    skipped: [],
    blockers: [],
    githubRepository: undefined,
    hasProductionDomainMapping: false,
    serviceNames: [],
    secretNames: [],
    artifactImages: [],
  };

  planGitHubRepository(plan);
  await planLocalDev(plan);
  planProductionDomainMapping(plan);
  planCloudRunServices(plan);
  planArtifactImages(plan);
  planSecrets(plan);
  await planNeon(plan);
  await planGrafana(plan);

  if (destroyProject) {
    plan.resources.push({ label: `GCP project ${config.project.id}`, detail: "requested with --project" });
  }

  return plan;
}

async function planLocalDev(plan: DestroyPlan) {
  const localDev = await buildLocalDevCleanupPlan({ dockerCompose: true });
  for (const resource of localDev.resources) {
    plan.resources.push({ label: resource, detail: "local" });
  }
  for (const skipped of localDev.skipped) {
    plan.skipped.push({ label: skipped, detail: "local" });
  }
}

function planGitHubRepository(plan: DestroyPlan) {
  const repository = `${config.git.owner}/${config.git.repository}`;
  if (!config.git.deleteOnDestroy) {
    plan.skipped.push({
      label: `GitHub repository ${repository}`,
      detail: config.git.enabled ? "not created by this service CLI run" : "git disabled",
    });
    return;
  }

  if (!Bun.which("gh")) {
    plan.blockers.push(`GitHub repository ${repository}: missing required command gh`);
    return;
  }

  const auth = run("gh", ["auth", "status"], { allowFailure: true });
  if (!auth.success) {
    plan.blockers.push(`GitHub repository ${repository}: authenticate GitHub CLI with gh auth login`);
    return;
  }

  const view = run("gh", ["repo", "view", repository, "--json", "name"], { allowFailure: true });
  if (!view.success) {
    plan.skipped.push({ label: `GitHub repository ${repository}`, detail: "not found" });
    return;
  }

  plan.githubRepository = repository;
  plan.resources.push({ label: `GitHub repository ${repository}`, detail: "private generated repo" });
}

function deleteGitHubRepository(repository: string) {
  run("gh", ["repo", "delete", repository, "--yes"], { allowFailure: true });
}

function planProductionDomainMapping(plan: DestroyPlan) {
  try {
    const mapping = describeProductionDomainMapping();
    if (!mapping) {
      plan.skipped.push({ label: `Production domain mapping ${config.domain.hostname}`, detail: "not found" });
      return;
    }

    const routeName = mapping.spec?.routeName ?? "";
    if (routeName !== config.serviceName) {
      plan.blockers.push(`${config.domain.hostname} maps to ${routeName || "an unknown service"}; refusing to delete ambiguous DNS mapping`);
      return;
    }

    assertOwnedResource(`Cloud Run service ${routeName}`, describeCloudRunService(routeName));
    plan.hasProductionDomainMapping = true;
    plan.resources.push({ label: `Production domain mapping ${config.domain.hostname}`, detail: `routes to ${routeName}` });
  } catch (error) {
    plan.blockers.push(`Production domain mapping ${config.domain.hostname}: ${formatError(error)}`);
  }
}

function planCloudRunServices(plan: DestroyPlan) {
  try {
    plan.serviceNames = listCloudRunServices().filter(matchesServiceResource);
    if (plan.serviceNames.length === 0) {
      plan.skipped.push({ label: `Cloud Run services in ${config.project.id}/${config.region}`, detail: "none matched" });
      return;
    }
    for (const serviceName of plan.serviceNames) {
      plan.resources.push({ label: `Cloud Run service ${serviceName}`, detail: `${config.project.id}/${config.region}` });
    }
  } catch (error) {
    plan.blockers.push(`Cloud Run services in ${config.project.id}/${config.region}: ${formatError(error)}`);
  }
}

function planArtifactImages(plan: DestroyPlan) {
  try {
    plan.artifactImages = listArtifactImages();
    if (plan.artifactImages.length === 0) {
      plan.skipped.push({ label: `Artifact Registry images for ${config.serviceName}`, detail: "none matched" });
      return;
    }
    for (const image of plan.artifactImages) {
      plan.resources.push({ label: `Artifact Registry image ${image}`, detail: `${config.project.id}/${config.region}` });
    }
  } catch (error) {
    plan.blockers.push(`Artifact Registry images for ${config.serviceName}: ${formatError(error)}`);
  }
}

function planSecrets(plan: DestroyPlan) {
  try {
    plan.secretNames = listSecrets().filter(matchesSecretResource);
    if (plan.secretNames.length === 0) {
      plan.skipped.push({ label: `Secret Manager secrets in ${config.project.id}`, detail: "none matched" });
      return;
    }
    for (const secretName of plan.secretNames) {
      plan.resources.push({ label: `Secret Manager secret ${secretName}`, detail: config.project.id });
    }
  } catch (error) {
    plan.blockers.push(`Secret Manager secrets in ${config.project.id}: ${formatError(error)}`);
  }
}

async function planNeon(plan: DestroyPlan) {
  try {
    const neon = await resolveNeonConfig();
    const branches = await listBranches(neon.projectId);
    const disposableBranches = branches.filter(
      (branch: { name: string }) =>
        branch.name.startsWith(`${neon.previewBranchPrefix}-`) || branch.name.startsWith(`${neon.personalBranchPrefix}-`)
    );

    plan.neon = {
      projectId: neon.projectId,
      baseBranchId: neon.baseBranchId,
      databaseName: neon.databaseName,
      branches: disposableBranches,
    };
    plan.resources.push({ label: `Neon database ${neon.databaseName}`, detail: `${neon.projectId}/${neon.baseBranchName}` });
    for (const branch of disposableBranches) {
      plan.resources.push({ label: `Neon branch ${branch.name}`, detail: neon.projectId });
    }
  } catch (error) {
    plan.skipped.push({ label: "Neon resources", detail: formatError(error) });
  }
}

async function planGrafana(plan: DestroyPlan) {
  if (!(await Bun.file("./grafana").exists())) {
    plan.skipped.push({ label: "Grafana resources", detail: "no ./grafana directory" });
    return;
  }
  if (!Bun.which("gcx")) {
    plan.skipped.push({ label: "Grafana resources", detail: "gcx is not installed" });
    return;
  }
  plan.resources.push({ label: "Grafana resources", detail: "./grafana manifests" });
}

function printDestroyPlan(plan: DestroyPlan) {
  const lines = [
    "Resources selected for destroy:",
    ...plan.resources.map((resource) => `- ${resource.label}${resource.detail ? ` (${resource.detail})` : ""}`),
  ];
  if (plan.skipped.length > 0) {
    lines.push("", "Skipped or not found:", ...plan.skipped.map((resource) => `- ${resource.label}${resource.detail ? ` (${resource.detail})` : ""}`));
  }
  if (plan.blockers.length > 0) {
    lines.push("", "Discovery blockers:", ...plan.blockers.map((blocker) => `- ${blocker}`));
  }
  log.step(lines.join("\n"));
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
