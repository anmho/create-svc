import { config, githubVariables } from "./config";
import { ensureDatabase, getConnectionUri } from "./neon";
import {
  addSecretVersion,
  attachBilling,
  ensureArtifactRepository,
  ensureProject,
  ensureProjectRole,
  ensureSecretAccessor,
  ensureServiceAccount,
  ensureServiceAccountRole,
  ensureWorkloadIdentityPool,
  ensureWorkloadIdentityProvider,
  gcloud,
  requireCommand,
  resolveDeploymentTarget,
  runMain,
  runStep,
  setGithubVariable,
  workloadIdentityPoolResource,
  workloadIdentityProviderResource,
} from "./lib";

export async function bootstrap() {
  requireCommand("gcloud");
  requireCommand("gh");

  await runStep("Ensuring GCP project", () => ensureProject());
  await runStep("Attaching billing", () => attachBilling());
  await runStep("Enabling required GCP APIs", () => gcloud(["services", "enable", ...config.requiredApis, "--project", config.project.id]));

  await runStep("Ensuring runtime and deployer service accounts", () => {
    ensureServiceAccount(config.runtimeServiceAccount);
    ensureServiceAccount(config.deployerServiceAccount);
  });

  await runStep("Ensuring Artifact Registry repository", () => ensureArtifactRepository());

  await runStep("Granting project roles", () => {
    ensureProjectRole(`serviceAccount:${config.deployerServiceAccount}`, "roles/run.admin");
    ensureProjectRole(`serviceAccount:${config.deployerServiceAccount}`, "roles/cloudbuild.builds.editor");
    ensureProjectRole(`serviceAccount:${config.deployerServiceAccount}`, "roles/artifactregistry.writer");
    ensureProjectRole(`serviceAccount:${config.deployerServiceAccount}`, "roles/serviceusage.serviceUsageConsumer");
    ensureProjectRole(`serviceAccount:${config.runtimeServiceAccount}`, "roles/secretmanager.secretAccessor");
    ensureServiceAccountRole(config.runtimeServiceAccount, `serviceAccount:${config.deployerServiceAccount}`, "roles/iam.serviceAccountUser");
  });

  await runStep("Ensuring Workload Identity setup", () => {
    ensureWorkloadIdentityPool();
    ensureWorkloadIdentityProvider();
    ensureServiceAccountRole(
      config.deployerServiceAccount,
      `principalSet://iam.googleapis.com/${workloadIdentityPoolResource()}/attribute.repository/${config.github.repo}`,
      "roles/iam.workloadIdentityUser"
    );
  });

  if (!config.neon.projectId || !config.neon.baseBranchId) {
    throw new Error("Neon project and base branch must be configured before bootstrap");
  }

  const target = resolveDeploymentTarget("main");
  await runStep("Ensuring Neon database", () => ensureDatabase(config.neon.projectId, config.neon.baseBranchId, config.neon.databaseName));

  await runStep("Publishing database secret", async () => {
    const connectionUri = await getConnectionUri(
      config.neon.projectId,
      config.neon.baseBranchId,
      config.neon.databaseName,
      config.neon.roleName
    );
    addSecretVersion(target.databaseSecretName, connectionUri);
    ensureSecretAccessor(target.databaseSecretName, `serviceAccount:${config.runtimeServiceAccount}`);
  });

  await runStep("Configuring GitHub repository variables", () => {
    for (const [name, value] of Object.entries(githubVariables)) {
      setGithubVariable(name, value);
    }

    setGithubVariable("GCP_WIF_PROVIDER", workloadIdentityProviderResource());
    setGithubVariable("GCP_DEPLOYER_SERVICE_ACCOUNT", config.deployerServiceAccount);
  });
}

if (import.meta.main) {
  await runMain("Bootstrap", async () => {
    await bootstrap();
    return `Bootstrap finished for ${config.serviceName}`;
  });
}
