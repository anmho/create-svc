import { config } from "./config";
import { bootstrap } from "./bootstrap";
import { deleteBranch, ensureBranch, ensureDatabase, getConnectionUri, listBranches, resolveNeonConfig } from "./neon";
import {
  addSecretVersion,
  deleteService,
  ensureArtifactRepository,
  ensureProductionDomainMapping,
  ensureSecretAccessor,
  gcloud,
  imageUrl,
  parseDeployArgs,
  requireCommand,
  resolveDeploymentTarget,
  runMain,
  runStep,
  serviceOrigin,
  writeRenderedManifest,
} from "./lib";

export async function deploy(args = Bun.argv.slice(2)) {
  requireCommand("gcloud");
  requireCommand("bun");

  const options = parseDeployArgs(args);
  if (!options.ci) {
    await bootstrap();
  }

  const target = resolveDeploymentTarget(options.environment, options.name);
  const neon = await runStep("Resolving Neon defaults", () => resolveNeonConfig());

  if (options.destroy) {
    if (options.environment === "main") {
      throw new Error("Refusing to destroy the main environment");
    }

    await runStep(`Deleting Cloud Run service ${target.serviceName}`, () => deleteService(target.serviceName));
    await runStep(`Deleting Neon branch ${target.branchName}`, async () => {
      const branches = await listBranches(neon.projectId);
      const branch = branches.find((candidate: { name: string }) => candidate.name === target.branchName);
      if (branch) {
        await deleteBranch(neon.projectId, branch.id);
      }
    });
    return `Destroyed ${target.serviceName}`;
  }

  await runStep("Ensuring Artifact Registry repository", () => ensureArtifactRepository());

  let branchId: string = neon.baseBranchId;
  if (options.environment !== "main") {
    const branch = await runStep(`Ensuring Neon branch ${target.branchName}`, () =>
      ensureBranch(neon.projectId, target.branchName, neon.baseBranchId)
    );
    branchId = branch.id;
  }

  await runStep("Publishing environment database secret", async () => {
    await ensureDatabase(neon.projectId, branchId, neon.databaseName);
    const connectionUri = await getConnectionUri(neon.projectId, branchId, neon.databaseName, neon.roleName);
    addSecretVersion(target.databaseSecretName, connectionUri);
    ensureSecretAccessor(target.databaseSecretName, `serviceAccount:${config.runtimeServiceAccount}`);
  });
  const image = imageUrl();
  await runStep("Building container image", () =>
    gcloud(["builds", "submit", "--project", config.project.id, "--region", config.region, "--tag", image])
  );

  const renderedManifestPath = await runStep("Rendering Cloud Run manifest", () => writeRenderedManifest(image, target));

  await runStep(`Deploying Cloud Run service ${target.serviceName}`, () =>
    gcloud(["run", "services", "replace", renderedManifestPath.pathname, "--project", config.project.id, "--region", config.region])
  );

  await runStep("Granting public invoker access", () =>
    gcloud([
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

if (import.meta.main) {
  await runMain("Deploy", () => deploy(Bun.argv.slice(2)));
}
