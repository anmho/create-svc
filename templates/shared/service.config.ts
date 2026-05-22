export default {
  service_id: "{{SERVICE_ID}}",
  target: "{{TARGET}}",
  runtime: "{{RUNTIME}}",
  framework: "{{FRAMEWORK}}",
  stage_default: "prod",
  dns: {
    hostname: "{{API_HOSTNAME}}",
    base_domain: "{{API_BASE_DOMAIN}}",
  },
  ownership: {
    managed_by: "create-service",
    service_id: "{{SERVICE_ID}}",
  },
  auth: {
    issuer: "https://auth.anmho.com",
    token_endpoint: "https://auth.anmho.com/api/auth/oauth2/token",
    jwks_url: "https://auth.anmho.com/api/auth/jwks",
    resource_server: {
      id: "{{SERVICE_ID}}",
      audience: "api://{{SERVICE_ID}}",
      default_scopes: ["{{SERVICE_ID}}:read", "{{SERVICE_ID}}:write"],
    },
    client: {
      app_id: "{{SERVICE_ID}}",
      identity: "server",
      vault_path_prefix: "prod/apps/{{SERVICE_ID}}/server/oauth-clients",
    },
  },
  temporal: {
    enabled: false,
    address: "localhost:7233",
    namespace: "default",
    task_queue: "{{SERVICE_ID}}",
    api_key_secret_name: "{{SERVICE_ID}}-temporal-api-key",
  },
  providers: {
    vault: {
      mount: "secret",
      neon_path: "prod/providers/neon",
      grafana_path: "prod/providers/grafana",
      clerk_m2m_path: "prod/providers/clerk-m2m",
      temporal_path: "prod/providers/temporal",
    },
  },
  buf: {
    module: "buf.build/anmho/{{SERVICE_ID}}",
  },
  cloudrun: {
    project_id: "{{PROJECT_ID}}",
    region: "{{REGION}}",
    service_account: "{{RUNTIME_SERVICE_ACCOUNT}}",
  },
  workers: {
    script_name: "{{SERVICE_ID}}",
    hyperdrive_binding: "HYPERDRIVE",
    cron: "*/15 * * * *",
  },
} as const;
