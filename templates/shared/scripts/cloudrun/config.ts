export const config = {
  serviceName: "{{SERVICE_NAME}}",
  profile: "{{PROFILE}}",
  example: {
    kind: "{{EXAMPLE_KIND}}",
    domain: "{{EXAMPLE_DOMAIN}}",
    label: "{{EXAMPLE_LABEL}}",
  },
  runtime: "{{RUNTIME}}",
  framework: "{{FRAMEWORK}}",
  region: "{{REGION}}",
  artifactRepository: "cloud-run",
  runtimeServiceAccount: "{{RUNTIME_SERVICE_ACCOUNT}}",
  project: {
    mode: "{{GCP_PROJECT_MODE}}",
    id: "{{PROJECT_ID}}",
    name: "{{PROJECT_NAME}}",
    createIfMissing: {{PROJECT_CREATE_IF_MISSING}},
    billingAccount: "{{BILLING_ACCOUNT}}",
    quotaProjectId: "{{QUOTA_PROJECT_ID}}",
  },
  domain: {
    hostname: "{{API_HOSTNAME}}",
    baseDomain: "{{API_BASE_DOMAIN}}",
  },
  storage: {
    attachmentBucket: "{{ATTACHMENT_BUCKET}}",
    attachmentPublicBaseUrl: "{{ATTACHMENT_PUBLIC_BASE_URL}}",
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
    "storage.googleapis.com",
    "sts.googleapis.com",
  ],
} as const;

export type DeployEnvironment = "main" | "preview" | "personal";
