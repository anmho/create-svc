import { config } from "./config";
import { ensureDatabase, getConnectionUri } from "./neon";
import {
  addSecretVersion,
  attachBilling,
  ensureArtifactRepository,
  ensureProject,
  ensureProjectRole,
  ensureSecretAccessor,
  ensureServiceAccount,
  gcloud,
  requireCommand,
  requireGcloudAuth,
  resolveDeploymentTarget,
  runMain,
  runStep,
} from "./lib";

export async function bootstrap() {
  requireCommand("gcloud");
  requireGcloudAuth();

  await runStep("Ensuring GCP project", () => ensureProject());
  await runStep("Attaching billing", () => attachBilling());
  await runStep("Enabling required GCP APIs", () => gcloud(["services", "enable", ...config.requiredApis, "--project", config.project.id]));

  await runStep("Ensuring runtime service account", () => {
    ensureServiceAccount(config.runtimeServiceAccount);
  });

  await runStep("Ensuring Artifact Registry repository", () => ensureArtifactRepository());

  await runStep("Granting project roles", () => {
    ensureProjectRole(`serviceAccount:${config.runtimeServiceAccount}`, "roles/secretmanager.secretAccessor");
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
}

if (import.meta.main) {
  await runMain("Bootstrap", async () => {
    await bootstrap();
    return `Bootstrap finished for ${config.serviceName}`;
  });
}
