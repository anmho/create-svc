import { config } from "./config";
import { bootstrap, type BootstrapResult } from "./bootstrap";
import { deleteBranch, ensureBranch, ensureDatabase, getConnectionUri, listBranches, resolveNeonConfig } from "./neon";
import {
  addSecretVersion,
  deleteService,
  deleteWorkerPool,
  dockerStreaming,
  ensureArtifactRepository,
  ensureProductionDomainMapping,
  ensureSecretAccessor,
  gcloud,
  gcloudStreaming,
  gcloudWithRetry,
  imageUrl,
  localDockerBuildArgs,
  parseDeployArgs,
  requireCommand,
  resolveTemporalRuntimeConfig,
  resolveDeploymentTarget,
  run,
  runMain,
  runStep,
  serviceOrigin,
  writeRenderedManifest,
  writeRenderedWorkerPoolManifest,
  writeRenderedCremaConfig,
} from "./lib";
import { cloudRunServiceNamesForDestroy, cloudRunWorkerPoolNamesForDestroy, migrationCommandForRuntime } from "./deploy-args";

type DeployOptions = {
  bootstrapResult?: BootstrapResult;
};

export async function deploy(args = Bun.argv.slice(2), deployOptions: DeployOptions = {}) {
  requireCommand("gcloud");
  requireCommand("bun");

  const options = parseDeployArgs(args);
  const bootstrapResult = deployOptions.bootstrapResult ?? (!options.ci ? await bootstrap() : undefined);

  const target =
    bootstrapResult && options.environment === "main" && !options.name
      ? bootstrapResult.target
      : resolveDeploymentTarget(options.environment, options.name);
  const neon = bootstrapResult?.neon ?? (await runStep("Resolving Neon defaults", () => resolveNeonConfig()));
  let databaseUrl = bootstrapResult?.databaseUrl;

  if (options.destroy) {
    if (options.environment === "main") {
      throw new Error("Refusing to destroy the main environment");
    }

    for (const serviceName of cloudRunServiceNamesForDestroy(target.serviceName)) {
      await runStep(`Deleting Cloud Run service ${serviceName}`, () => deleteService(serviceName));
    }
    for (const poolName of cloudRunWorkerPoolNamesForDestroy(target.serviceName)) {
      await runStep(`Deleting Cloud Run worker pool ${poolName}`, () => deleteWorkerPool(poolName));
    }
    await runStep(`Deleting Neon branch ${target.branchName}`, async () => {
      const branches = await listBranches(neon.projectId);
      const branch = branches.find((candidate: { name: string }) => candidate.name === target.branchName);
      if (branch) {
        await deleteBranch(neon.projectId, branch.id);
      }
    });
    return `Destroyed ${target.serviceName}`;
  }

  if (!bootstrapResult?.artifactRepositoryReady) {
    await runStep("Ensuring Artifact Registry repository", () => ensureArtifactRepository());
  }

  let branchId: string = neon.baseBranchId;
  if (options.environment !== "main") {
    const branch = await runStep(`Ensuring Neon branch ${target.branchName}`, () =>
      ensureBranch(neon.projectId, target.branchName, neon.baseBranchId)
    );
    branchId = branch.id;
  }

  if (!bootstrapResult || target.environment !== "main") {
    await runStep("Publishing environment database secret", async () => {
      await ensureDatabase(neon.projectId, branchId, neon.databaseName);
      const connectionUri = await getConnectionUri(neon.projectId, branchId, neon.databaseName, neon.roleName);
      databaseUrl = connectionUri;
      addSecretVersion(target.databaseSecretName, connectionUri);
      ensureSecretAccessor(target.databaseSecretName, `serviceAccount:${config.runtimeServiceAccount}`);
    });
  }
  if (!databaseUrl) {
    throw new Error(`Could not resolve database URL for ${target.serviceName}`);
  }
  const resolvedDatabaseUrl = databaseUrl;
  await runStep("Applying database migrations", () => runMigration(resolvedDatabaseUrl));

  const image = imageUrl();
  if (options.build === "cloudbuild") {
    await runStep("Building container image in Cloud Build", () =>
      gcloudStreaming(["builds", "submit", "--project", config.project.id, "--region", config.region, "--tag", image])
    );
  } else {
    requireCommand("docker");
    await runStep("Authenticating Docker to Artifact Registry", () =>
      gcloud(["auth", "configure-docker", `${config.region}-docker.pkg.dev`, "--quiet"])
    );
    await runStep("Building container image locally", () => dockerStreaming(localDockerBuildArgs(image)));
    await runStep("Pushing container image to Artifact Registry", () => dockerStreaming(["push", image]));
  }

  const renderedManifestPath = await runStep("Rendering Cloud Run manifest", () => writeRenderedManifest(image, target));

  await runStep(`Deploying Cloud Run service ${target.serviceName}`, () =>
    gcloud(["run", "services", "replace", renderedManifestPath.pathname, "--project", config.project.id, "--region", config.region])
  );

  if (resolveTemporalRuntimeConfig().enabled) {
    const renderedWorkerPoolPath = await runStep("Rendering Cloud Run worker pool manifest", () => writeRenderedWorkerPoolManifest(image, target));
    await runStep(`Deploying Cloud Run worker pool ${target.serviceName}-worker`, () =>
      gcloud(["run", "worker-pools", "replace", renderedWorkerPoolPath.pathname, "--project", config.project.id, "--region", config.region])
    );
    await runStep("Rendering CREMA autoscaler config", async () => {
      await writeRenderedCremaConfig(target);
      return "Wrote .crema-config.rendered.yaml — publish to Parameter Manager (crema-config); see plans/temporal-worker-pools-crema.md";
    });
  }

  await runStep("Granting public invoker access", () =>
    gcloudWithRetry([
      "run",
      "services",
      "add-iam-policy-binding",
      target.serviceName,
      "--project",
      config.project.id,
      "--region",
      config.region,
      "--member",
      "allUsers",
      "--role",
      "roles/run.invoker",
    ])
  );

  if (target.environment === "main") {
    await runStep(`Ensuring production domain mapping for ${config.domain.hostname}`, () => ensureProductionDomainMapping(target.serviceName));
  }

  return serviceOrigin(target);
}

function runMigration(databaseUrl: string) {
  const task = migrationCommandForRuntime(config.runtime);
  run(task.command, task.args, { env: { DATABASE_URL: databaseUrl } });
  return "migrate finished";
}

if (import.meta.main) {
  await runMain("Deploy", () => deploy(Bun.argv.slice(2)));
}
