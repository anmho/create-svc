export const config = {
  serviceName: "{{SERVICE_NAME}}",
  projectId: "{{PROJECT_ID}}",
  region: "{{REGION}}",
  githubRepo: "{{GITHUB_REPO}}",
  bufModule: "{{BUF_MODULE}}",
  artifactRepository: "cloud-run",
  runtimeServiceAccount: "{{RUNTIME_SERVICE_ACCOUNT}}",
  deployerServiceAccount: "{{DEPLOYER_SERVICE_ACCOUNT}}",
  vaultRoleIdSecret: "{{VAULT_ROLE_ID_SECRET}}",
  vaultSecretIdSecret: "{{VAULT_SECRET_ID_SECRET}}",
  workloadIdentityPoolId: "{{WIF_POOL_ID}}",
  workloadIdentityProviderId: "{{WIF_PROVIDER_ID}}",
  requiredApis: [
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
  ],
  githubVariables: {
    GCP_PROJECT_ID: "{{PROJECT_ID}}",
    GCP_REGION: "{{REGION}}",
    CLOUD_RUN_SERVICE: "{{SERVICE_NAME}}",
  },
} as const;

export const manifestEnv = {
  SERVICE_NAME: "{{SERVICE_NAME}}",
  RUNTIME_SERVICE_ACCOUNT: "{{RUNTIME_SERVICE_ACCOUNT}}",
  VAULT_ADDR: "{{VAULT_ADDR}}",
  VAULT_SECRET_PATH: "{{VAULT_SECRET_PATH}}",
  VAULT_SECRET_KEY: "{{VAULT_SECRET_KEY}}",
  CLOUDFLARE_ZONE_ID: "{{CLOUDFLARE_ZONE_ID}}",
  VAULT_ROLE_ID_SECRET: "{{VAULT_ROLE_ID_SECRET}}",
  VAULT_SECRET_ID_SECRET: "{{VAULT_SECRET_ID_SECRET}}",
} as const;

export const bootstrapSecrets = [
  {
    secretName: "{{VAULT_ROLE_ID_SECRET}}",
    bootstrapEnv: "BOOTSTRAP_VAULT_ROLE_ID",
  },
  {
    secretName: "{{VAULT_SECRET_ID_SECRET}}",
    bootstrapEnv: "BOOTSTRAP_VAULT_SECRET_ID",
  },
] as const;
