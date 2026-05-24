import { config } from "./config";
import { ensureDatabase, getConnectionUri, resolveNeonConfig, type ResolvedNeonConfig } from "./neon";
import {
  addSecretVersion,
  attachBilling,
  ensureArtifactRepository,
  ensureProject,
  ensureProjectRole,
  ensureRequiredApis,
  ensureSecretAccessor,
  ensureServiceAccount,
  requireCommand,
  requireGcloudAuth,
  resolveDeploymentTarget,
  resolveTemporalRuntimeConfig,
  runMain,
  runStep,
  type DeploymentTarget,
} from "./lib";

export type BootstrapResult = {
  target: DeploymentTarget;
  neon: ResolvedNeonConfig;
  databaseUrl: string;
  artifactRepositoryReady: boolean;
};

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

  const databaseUrl = await runStep("Publishing database secret", async () => {
    const connectionUri = await getConnectionUri(
      neon.projectId,
      neon.baseBranchId,
      neon.databaseName,
      neon.roleName
    );
    addSecretVersion(target.databaseSecretName, connectionUri);
    ensureSecretAccessor(target.databaseSecretName, `serviceAccount:${config.runtimeServiceAccount}`);
    return connectionUri;
  });

  if (shouldPublishTemporalSecrets()) {
    await runStep("Publishing Temporal secrets", () => publishTemporalSecrets());
  }

  return {
    target,
    neon,
    databaseUrl,
    artifactRepositoryReady: true,
  } satisfies BootstrapResult;
}

export async function prepareGcpProject() {
  await runStep("Ensuring GCP project", () => ensureProject());
  await runStep("Attaching billing", () => attachBilling());
  await runStep("Enabling required GCP APIs", () => ensureRequiredApis());
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

function shouldPublishTemporalSecrets() {
  const temporal = resolveTemporalRuntimeConfig();
  return Boolean(process.env.TEMPORAL_API_KEY?.trim() && temporal.apiKeySecretName);
}

if (import.meta.main) {
  await runMain("Bootstrap", async () => {
    await bootstrap();
    return `Bootstrap finished for ${config.serviceName}`;
  });
}
