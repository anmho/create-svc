export const config = {
  serviceName: "{{SERVICE_NAME}}",
  runtime: "{{RUNTIME}}",
  framework: "{{FRAMEWORK}}",
  region: "{{REGION}}",
  artifactRepository: "cloud-run",
  runtimeServiceAccount: "{{RUNTIME_SERVICE_ACCOUNT}}",
  deployerServiceAccount: "{{DEPLOYER_SERVICE_ACCOUNT}}",
  workloadIdentityPoolId: "{{WIF_POOL_ID}}",
  workloadIdentityProviderId: "{{WIF_PROVIDER_ID}}",
  project: {
    mode: "{{GCP_PROJECT_MODE}}",
    id: "{{PROJECT_ID}}",
    name: "{{PROJECT_NAME}}",
    createIfMissing: {{PROJECT_CREATE_IF_MISSING}},
    billingAccount: "{{BILLING_ACCOUNT}}",
    quotaProjectId: "{{QUOTA_PROJECT_ID}}",
  },
  github: {
    repo: "{{GITHUB_REPO}}",
    visibility: "{{GITHUB_VISIBILITY}}",
    createIfMissing: {{GITHUB_CREATE_IF_MISSING}},
  },
  neon: {
    projectId: "{{NEON_PROJECT_ID}}",
    baseBranchId: "{{NEON_BASE_BRANCH_ID}}",
    baseBranchName: "{{NEON_BASE_BRANCH_NAME}}",
    databaseName: "{{NEON_DATABASE_NAME}}",
    roleName: "{{NEON_ROLE_NAME}}",
    previewBranchPrefix: "{{NEON_PREVIEW_BRANCH_PREFIX}}",
    personalBranchPrefix: "{{NEON_PERSONAL_BRANCH_PREFIX}}",
  },
  requiredApis: [
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ],
} as const;

export const githubVariables = {
  GCP_PROJECT_ID: "{{PROJECT_ID}}",
  GCP_REGION: "{{REGION}}",
  CLOUD_RUN_SERVICE: "{{SERVICE_NAME}}",
  CREATE_SVC_RUNTIME: "{{RUNTIME}}",
  CREATE_SVC_FRAMEWORK: "{{FRAMEWORK}}",
  NEON_PROJECT_ID: "{{NEON_PROJECT_ID}}",
  NEON_BASE_BRANCH_ID: "{{NEON_BASE_BRANCH_ID}}",
  NEON_DATABASE_NAME: "{{NEON_DATABASE_NAME}}",
} as const;

export type DeployEnvironment = "main" | "preview" | "personal";

