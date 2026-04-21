import { bootstrapSecrets, config } from "./config";
import {
  ensureProjectRole,
  ensureSecret,
  ensureSecretAccessor,
  ensureServiceAccount,
  ensureServiceAccountRole,
  ensureWorkloadIdentityPool,
  ensureWorkloadIdentityProvider,
  gcloud,
  requireCommand,
  setGithubSecret,
  setGithubVariable,
  workloadIdentityPoolResource,
  workloadIdentityProviderResource,
} from "./lib";

export async function bootstrap() {
  requireCommand("gcloud");
  requireCommand("gh");

  gcloud(["services", "enable", ...config.requiredApis, "--project", config.projectId]);

  ensureServiceAccount(config.runtimeServiceAccount);
  ensureServiceAccount(config.deployerServiceAccount);

  ensureProjectRole(`serviceAccount:${config.deployerServiceAccount}`, "roles/run.admin");
  ensureProjectRole(`serviceAccount:${config.deployerServiceAccount}`, "roles/cloudbuild.builds.editor");
  ensureProjectRole(`serviceAccount:${config.deployerServiceAccount}`, "roles/serviceusage.serviceUsageConsumer");

  ensureServiceAccountRole(config.runtimeServiceAccount, `serviceAccount:${config.deployerServiceAccount}`, "roles/iam.serviceAccountUser");

  for (const secret of bootstrapSecrets) {
    ensureSecret(secret.secretName, secret.bootstrapEnv);
    ensureSecretAccessor(secret.secretName, `serviceAccount:${config.runtimeServiceAccount}`);
  }

  ensureWorkloadIdentityPool();
  ensureWorkloadIdentityProvider();

  ensureServiceAccountRole(
    config.deployerServiceAccount,
    `principalSet://iam.googleapis.com/${workloadIdentityPoolResource()}/attribute.repository/${config.githubRepo}`,
    "roles/iam.workloadIdentityUser"
  );

  for (const [name, value] of Object.entries(config.githubVariables)) {
    setGithubVariable(name, value);
  }
  setGithubVariable("GCP_WIF_PROVIDER", workloadIdentityProviderResource());
  setGithubVariable("GCP_DEPLOYER_SERVICE_ACCOUNT", config.deployerServiceAccount);

  if (config.bufModule) {
    setGithubVariable("BUF_MODULE", config.bufModule);
  }

  const bufToken = process.env.BUF_TOKEN?.trim();
  if (bufToken && config.bufModule) {
    setGithubSecret("BUF_TOKEN", bufToken);
  }
}

if (import.meta.main) {
  await bootstrap();
}
