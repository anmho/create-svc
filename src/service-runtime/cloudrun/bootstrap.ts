import { config } from "./config";
import { ensureDatabase, getConnectionUri, resolveNeonConfig } from "./neon";
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
  resolveTemporalRuntimeConfig,
  runMain,
  runStep,
} from "./lib";

export async function bootstrap(options: { skipProjectSetup?: boolean } = {}) {
  requireCommand("gcloud");
  requireGcloudAuth();

  if (!options.skipProjectSetup) {
    await prepareGcpProject();
  }

  await runStep("Ensuring runtime service account", () => {
    ensureServiceAccount(config.runtimeServiceAccount);
  });

  await runStep("Ensuring Artifact Registry repository", () => ensureArtifactRepository());
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

  await runStep("Publishing Temporal secrets", () => publishTemporalSecrets());
}

export async function prepareGcpProject() {
  await runStep("Ensuring GCP project", () => ensureProject());
  await runStep("Attaching billing", () => attachBilling());
  await runStep("Enabling required GCP APIs", () => gcloud(["services", "enable", ...config.requiredApis, "--project", config.project.id]));
}

function publishTemporalSecrets() {
  const temporal = resolveTemporalRuntimeConfig();
  const apiKey = process.env.TEMPORAL_API_KEY?.trim();
  if (!apiKey || !temporal.apiKeySecretName) {
    return "No Temporal API key configured";
  }

  addSecretVersion(temporal.apiKeySecretName, apiKey);
  ensureSecretAccessor(temporal.apiKeySecretName, `serviceAccount:${config.runtimeServiceAccount}`);
  return temporal.apiKeySecretName;
}

if (import.meta.main) {
  await runMain("Bootstrap", async () => {
    await bootstrap();
    return `Bootstrap finished for ${config.serviceName}`;
  });
}
