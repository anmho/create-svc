import { config } from "./config";
import { publishProviderRuntimeSecrets } from "./integrations";
import { ensureDatabase, getConnectionUri, resolveNeonConfig } from "./neon";
import {
  addSecretVersion,
  attachBilling,
  ensureArtifactRepository,
  ensureProject,
  ensureProjectRole,
  ensureSecretAccessor,
  ensureServiceAccount,
  ensureStorageBucket,
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
  await runStep("Ensuring attachment storage bucket", () => ensureStorageBucket());

  await runStep("Granting project roles", () => {
    ensureProjectRole(`serviceAccount:${config.runtimeServiceAccount}`, "roles/secretmanager.secretAccessor");
  });

  const neon = await runStep("Resolving Neon defaults", () => resolveNeonConfig());

  const target = resolveDeploymentTarget("main");
  await runStep("Ensuring Neon database", () => ensureDatabase(neon.projectId, neon.baseBranchId, neon.databaseName));

  await runStep("Publishing database secret", async () => {
    const connectionUri = await getConnectionUri(
      neon.projectId,
      neon.baseBranchId,
      neon.databaseName,
      neon.roleName
    );
    addSecretVersion(target.databaseSecretName, connectionUri);
    ensureSecretAccessor(target.databaseSecretName, `serviceAccount:${config.runtimeServiceAccount}`);
  });

  await runStep("Publishing provider runtime secrets", () => publishProviderRuntimeSecrets(target));
}

if (import.meta.main) {
  await runMain("Bootstrap", async () => {
    await bootstrap();
    return `Bootstrap finished for ${config.serviceName}`;
  });
}
