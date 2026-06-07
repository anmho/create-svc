import { serviceConfig } from "../runtime";

const cloudrun = serviceConfig.cloudrun;
const dns = serviceConfig.dns;
const neon = serviceConfig.neon;
const vault = serviceConfig.providers?.vault ?? {};

export const config = {
  serviceName: serviceConfig.service_id,
  profile: serviceConfig.profile,
  example: serviceConfig.example,
  runtime: serviceConfig.runtime,
  framework: serviceConfig.framework,
  region: cloudrun.region,
  artifactRepository: cloudrun.artifact_repository,
  runtimeServiceAccount: cloudrun.service_account,
  workerMinInstances: Number(cloudrun.worker_min_instances ?? 0),
  project: {
    mode: cloudrun.project_mode,
    id: cloudrun.project_id,
    name: cloudrun.project_name,
    createIfMissing: cloudrun.create_if_missing,
    billingAccount: cloudrun.billing_account,
    quotaProjectId: cloudrun.quota_project_id,
  },
  domain: {
    hostname: dns.hostname,
    baseDomain: dns.base_domain,
    cloudflareApiBaseUrl: dns.cloudflare_api_base_url,
    cloudflareVaultPath: dns.cloudflare_vault_path,
    cloudflareVaultField: dns.cloudflare_vault_field,
  },
  auth: {
    issuer: serviceConfig.auth.issuer,
    audience: serviceConfig.auth.resource_server.audience,
    jwksUrl: serviceConfig.auth.jwks_url,
  },
  temporal: {
    enabled: serviceConfig.temporal.enabled,
    address: serviceConfig.temporal.address,
    namespace: serviceConfig.temporal.namespace,
    taskQueue: serviceConfig.temporal.task_queue,
    apiKeySecretName: serviceConfig.temporal.api_key_secret_name,
    tlsCaCertSecretName: serviceConfig.temporal.tls_ca_cert_secret_name,
    tlsCertSecretName: serviceConfig.temporal.tls_cert_secret_name,
    tlsKeySecretName: serviceConfig.temporal.tls_key_secret_name,
    vaultMount: vault.mount || "secret",
    vaultPath: vault.temporal_path || "prod/providers/temporal",
  },
  buf: {
    module: serviceConfig.buf?.module || `buf.build/anmho-services/${serviceConfig.service_id}`,
    vaultMount: vault.mount || "secret",
    vaultPath: vault.buf_path || "prod/providers/buf",
  },
  neon: {
    projectId: neon.project_id,
    baseBranchId: neon.base_branch_id,
    baseBranchName: neon.base_branch_name,
    databaseName: neon.database_name,
    roleName: neon.role_name,
    previewBranchPrefix: neon.preview_branch_prefix,
    personalBranchPrefix: neon.personal_branch_prefix,
  },
  git: {
    enabled: Boolean(serviceConfig.git?.enabled),
    owner: serviceConfig.git?.owner || "anmho",
    repository: serviceConfig.git?.repository || serviceConfig.service_id,
    deleteOnDestroy: Boolean(serviceConfig.git?.delete_on_destroy),
  },
  observability: {
    requiredApis: serviceConfig.observability?.required_apis ?? ["logging.googleapis.com", "monitoring.googleapis.com", "cloudtrace.googleapis.com"],
  },
  requiredApis: cloudrun.required_apis,
} as const;

export type DeployEnvironment = "main" | "preview" | "personal";
