import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveLocalPostgresPort } from "./naming";
import { DirectoryConflictError, assertTargetDirectoryIsEmpty, scaffoldProject, type ScaffoldConfig } from "./scaffold";

function baseConfig(overrides: Partial<ScaffoldConfig> = {}): ScaffoldConfig {
  return {
    directory: "svc",
    serviceName: "dns-api",
    modulePath: "example.com/dns-api",
    target: "cloudrun",
    runtime: "bun",
    framework: "hono",
    region: "us-west1",
    gcpProjectMode: "create_new",
    gcpProject: "anmho-dns-api",
    gcpProjectName: "dns-api",
    billingAccount: "billingAccounts/01BD2E-3A6949-8F4C84",
    quotaProjectId: "anmho-infra-prod",
    profile: "microservice",
    git: {
      enabled: false,
      owner: "anmho",
      repository: "dns-api",
    },
    neonDatabaseName: "dns_api",
    apiHostname: "api.dns-api.anmho.com",
    generatorRoot: join(import.meta.dir, ".."),
    ...overrides,
    autoDeploy: overrides.autoDeploy ?? false,
  };
}

test("scaffolds all runtime/framework variants with shared cloudrun config", async () => {
  const cases: Array<Pick<ScaffoldConfig, "runtime" | "framework">> = [
    { runtime: "go", framework: "chi" },
    { runtime: "go", framework: "connectrpc" },
    { runtime: "bun", framework: "hono" },
    { runtime: "bun", framework: "connectrpc" },
  ];

  for (const variant of cases) {
    const root = await mkdtemp(join(tmpdir(), "create-svc-"));
    const generatedRoot = join(root, `${variant.runtime}-${variant.framework}`);
    const localPort = deriveLocalPostgresPort("dns-api");

    await scaffoldProject(
      baseConfig({
        directory: generatedRoot,
        runtime: variant.runtime,
        framework: variant.framework,
      })
    );

    const configScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "config.ts")).text();
    const serviceConfig = await Bun.file(join(generatedRoot, "service.config.ts")).text();
    expect(serviceConfig).toContain('service_id: "dns-api"');
    expect(serviceConfig).toContain('target: "cloudrun"');
    expect(serviceConfig).toContain('module: "buf.build/anmho/dns-api"');
    expect(serviceConfig).toContain('issuer: "https://auth.anmho.com/api/auth"');
    expect(serviceConfig).toContain('audience: "api://dns-api"');
    expect(serviceConfig).toContain('vault_path_prefix: "prod/apps/dns-api/server/oauth-clients"');
    expect(serviceConfig).toContain('api_key_secret_name: "dns-api-temporal-api-key"');
    expect(configScript).toContain('profile: "microservice"');
    expect(configScript).toContain('domain: "waitlist"');
    expect(configScript).toContain('kind: "microservice"');
    expect(configScript).toContain(`runtime: "${variant.runtime}"`);
    expect(configScript).toContain(`framework: "${variant.framework}"`);
    expect(configScript).toContain('mode: "create_new"');
    expect(configScript).toContain('quotaProjectId: "anmho-infra-prod"');
    expect(configScript).toContain('issuer: "https://auth.anmho.com/api/auth"');
    expect(configScript).toContain('audience: "api://dns-api"');
    expect(configScript).toContain('jwksUrl: "https://auth.anmho.com/api/auth/jwks"');
    expect(configScript).toContain('apiKeySecretName: "dns-api-temporal-api-key"');
    expect(configScript).toContain('projectId: ""');
    expect(configScript).toContain('baseBranchId: ""');
    expect(configScript).toContain('baseBranchName: "main"');
    expect(configScript).toContain('previewBranchPrefix: "dns-api-pr"');
    expect(configScript).toContain('hostname: "api.dns-api.anmho.com"');
    expect(configScript).not.toContain("github:");
    expect(configScript).not.toContain("attachmentBucket");

    const deployScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "lib.ts")).text();
    expect(deployScript).toContain('--billing-project", config.project.quotaProjectId');
    expect(deployScript).toContain('config.project.mode === "use_existing"');
    expect(deployScript).toContain("serviceDomain");
    expect(deployScript).toContain("ensureProductionDomainMapping");
    expect(deployScript).toContain('"domain-mappings",');
    expect(deployScript).toContain('"--region",');
    expect(deployScript).toContain("assertProductionDomainAvailable");
    expect(deployScript).toContain("assertServiceNameAvailable");
    expect(deployScript).not.toContain("ensureStorageBucket");

    expect(await Bun.file(join(generatedRoot, "scripts", "cloudrun", "integrations.ts")).exists()).toBeFalse();
    const destroyScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "cleanup.ts")).text();
    expect(destroyScript).toContain("assertOwnedResource");
    expect(destroyScript).toContain("assertProductionDomainMappingOwned");
    expect(destroyScript).toContain("deleteGrafanaResources");
    expect(destroyScript).toContain('gcx", ["resources", "delete"');
    expect(destroyScript).toContain("config.temporal.apiKeySecretName");
    const neonScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "neon.ts")).text();
    expect(neonScript).toContain("assertDatabaseOwned");
    expect(neonScript).toContain("assertDisposableBranchName");
    const seedScript = await Bun.file(join(generatedRoot, "scripts", "seed.ts")).text();
    expect(seedScript).toContain("SEED_PROD=true");
    expect(seedScript).toContain("waitlist_entries");

    const manifest = await Bun.file(join(generatedRoot, "service.yaml")).text();
    expect(manifest).toContain("DATABASE_URL");
    expect(manifest).toContain("TEMPORAL_ENABLED");
    expect(manifest).toContain("TEMPORAL_TASK_QUEUE");
    expect(manifest).toContain("TEMPORAL_API_KEY_ENV");
    expect(manifest).toContain("AUTH_ENABLED");
    expect(manifest).toContain("${AUTH_AUDIENCE}");
    expect(manifest).toContain("managed_by: create-service");
    expect(manifest).toContain("service_id: ${SERVICE_ID}");
    expect(manifest).not.toContain("CLERK_SECRET_KEY");
    expect(manifest).not.toContain("STRIPE_SECRET_KEY");
    expect(manifest).not.toContain("REVENUECAT_API_KEY");
    expect(manifest).not.toContain("RESEND_API_KEY");
    expect(manifest).not.toContain("POSTHOG_API_KEY");

    const gitignore = await Bun.file(join(generatedRoot, ".gitignore")).text();
    expect(gitignore).toContain("node_modules");
    expect(await Bun.file(join(generatedRoot, "website", "package.json")).exists()).toBeFalse();

    const dockerCompose = await Bun.file(join(generatedRoot, "docker-compose.yml")).text();
    expect(dockerCompose).toContain('image: postgres:16-alpine');
    expect(dockerCompose).toContain(`127.0.0.1:${localPort}:5432`);

    const envExample = await Bun.file(join(generatedRoot, ".env.example")).text();
    expect(envExample).toContain(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${localPort}/dns_api?sslmode=disable`);
    expect(envExample).toContain("AUTH_ENABLED=false");
    expect(envExample).toContain("AUTH_AUDIENCE=api://dns-api");
    expect(envExample).toContain("CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_ID=");
    expect(envExample).toContain("TEMPORAL_API_KEY=");
    expect(envExample).toContain("The base waitlist service does not require");
    expect(envExample).not.toContain("ATTACHMENT_BUCKET=");
    expect(envExample).not.toContain("CLERK_SECRET_KEY=");
    expect(envExample).not.toContain("STRIPE_SECRET_KEY=");
    expect(envExample).not.toContain("REVENUECAT_API_KEY=");
    expect(envExample).not.toContain("RESEND_API_KEY=");
    expect(envExample).not.toContain("POSTHOG_API_KEY=");

    const localEnv = await Bun.file(join(generatedRoot, ".env.local")).text();
    expect(localEnv).toContain(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${localPort}/dns_api?sslmode=disable`);
    expect(localEnv).not.toContain("ATTACHMENT_PUBLIC_BASE_URL=");

    const ciWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "ci.yml")).text();
    expect(ciWorkflow).toContain("bun run dashboards");
    expect(ciWorkflow).toContain("GCX_ENABLED");
    expect(await Bun.file(join(generatedRoot, "grafana", "waitlist-dashboard.json")).exists()).toBeTrue();
    expect(await Bun.file(join(generatedRoot, "grafana", "alerts.yaml")).exists()).toBeTrue();

    if (variant.runtime === "go") {
      const goMod = await Bun.file(join(generatedRoot, "go.mod")).text();
      expect(goMod).toContain("module example.com/dns-api");
      expect(goMod).not.toContain("module github.com/anmho/dns-api");

      const mainGo = await Bun.file(join(generatedRoot, "cmd", "server", "main.go")).text();
      expect(mainGo).toContain("example.com/dns-api");
      if (variant.framework === "connectrpc") {
        expect(goMod).toContain("connectrpc.com/connect");
        expect(mainGo).toContain("NewWaitlistService");
        expect(mainGo).toContain("WaitlistServiceName");
      } else {
        expect(goMod).not.toContain("connectrpc.com/connect");
        expect(mainGo).toContain("NewWaitlistService");
        const routes = await Bun.file(join(generatedRoot, "internal", "httpapi", "routes.go")).text();
        expect(routes).toContain("/v1/waitlist");
        expect(routes).toContain("/v1/admin/waitlist");
        expect(routes).toContain("/v1/triggers/waitlist");
        expect(await Bun.file(join(generatedRoot, "buf.yaml")).exists()).toBeFalse();
      }
      expect(mainGo).toContain("internal/auth");
      expect(mainGo).toContain("cfg.AuthAudience");
      expect(mainGo).toContain("cfg.TemporalAPIKey");
      expect(await Bun.file(join(generatedRoot, "internal", "auth", "middleware.go")).exists()).toBeTrue();
      const makefile = await Bun.file(join(generatedRoot, "Makefile")).text();
      expect(makefile).toContain("$(ATLAS) migrate apply --env local");
      expect(makefile).toContain("$(ATLAS) migrate lint --env local --latest 1");
      expect(makefile).toContain("bun run ./scripts/ensure-local-db.ts");
      expect(makefile).toContain("bun run ./scripts/wait-for-db.ts");
      expect(makefile).toContain("bun run ./scripts/dev.ts go run ./cmd/server");
      expect(await Bun.file(join(generatedRoot, "atlas.hcl")).exists()).toBeTrue();
      expect(await Bun.file(join(generatedRoot, "migrations", "atlas.sum")).exists()).toBeTrue();
      expect(await Bun.file(join(generatedRoot, "cmd", "migrate", "main.go")).exists()).toBeFalse();
      expect(await Bun.file(join(generatedRoot, "internal", "temporal", "worker.go")).exists()).toBeTrue();
      expect(goMod).toContain("go.temporal.io/sdk");
    } else {
      const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
      expect(packageJson).toContain('"@anmho/authctl": "0.1.1"');
      expect(packageJson).toContain("@temporalio/worker");
      expect(packageJson).toContain('"service": "./scripts/cloudrun/cli.ts"');
      expect(packageJson).toContain('"dev": "bun run ./scripts/dev.ts bun run ./src/index.ts"');
      expect(packageJson).toContain('"gen": "bun run ./scripts/codegen.ts"');
      expect(packageJson).toContain('"create": "bun run ./scripts/cloudrun/cli.ts create"');
      expect(packageJson).toContain('"deploy": "bun run ./scripts/cloudrun/cli.ts deploy"');
      expect(packageJson).toContain('"dashboards": "bun run ./scripts/cloudrun/cli.ts dashboards"');
      expect(packageJson).toContain('"auth": "bun run ./scripts/cloudrun/cli.ts auth"');
      expect(packageJson).toContain('"destroy": "bun run ./scripts/cloudrun/cli.ts destroy"');
      const serviceCli = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "cli.ts")).text();
      expect(serviceCli).toContain("service <create|deploy|migrate|seed|dashboards|dns|doctor|destroy|auth|sdk>");
      expect(serviceCli).toContain("assertServiceNameAvailable(config.serviceName)");
      expect(serviceCli).toContain("ensureAuthResourceServer");
      expect(serviceCli).toContain('["resources", "push", "--path", "./grafana"]');
      const cloudrunLib = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "lib.ts")).text();
      expect(cloudrunLib).toContain("resolveTemporalRuntimeConfig");
      expect(cloudrunLib).toContain("TEMPORAL_API_KEY_ENV");
      expect(cloudrunLib).toContain("value === undefined");

      const authctlScript = await Bun.file(join(generatedRoot, "scripts", "authctl.ts")).text();
      expect(authctlScript).toContain("authctl");
      expect(authctlScript).toContain("resource-servers");
      expect(authctlScript).toContain("clients");
      expect(authctlScript).toContain("defaultClientTargetArgs");
      expect(authctlScript).toContain('existsSync("./node_modules/.bin/authctl") ? "./node_modules/.bin/authctl" : Bun.which("authctl")');
      expect(authctlScript).not.toContain('defaultAuthResourceServerArgs(), "--yes", "--json"');
      const authScript = await Bun.file(join(generatedRoot, "src", "auth.ts")).text();
      expect(authScript).toContain('"Ed25519"');

      const makefile = await Bun.file(join(generatedRoot, "Makefile")).text();
      expect(makefile).toContain("npx --no-install service");
      expect(makefile).toContain("dashboards:");
      expect(makefile).toContain("auth:");
      expect(makefile).toContain("bun run dev");
      const devScript = await Bun.file(join(generatedRoot, "scripts", "dev.ts")).text();
      expect(devScript).toContain("ensureLocalPostgres");
      const localDocker = await Bun.file(join(generatedRoot, "scripts", "local-docker.ts")).text();
      expect(localDocker).toContain('["docker", "info"]');
      expect(localDocker).toContain('["open", "-a", "Docker"]');
      expect(localDocker).toContain('["docker", "compose", "up", "-d"]');

      const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
      expect(await Bun.file(join(generatedRoot, "src", "auth.ts")).exists()).toBeTrue();
      expect(entrypoint).toContain(variant.framework === "hono" ? 'app.use("/v1/*", authMiddleware())' : "withServiceAuth");
      expect(await Bun.file(join(generatedRoot, "src", "temporal", "worker.ts")).exists()).toBeTrue();
      const readme = await Bun.file(join(generatedRoot, "README.md")).text();
      if (variant.framework === "connectrpc") {
        expect(entrypoint).toContain("WaitlistService");
        expect(gitignore).not.toContain("gen/");
        expect(readme).toContain("Local introspection");
      } else {
        expect(entrypoint).toContain("/v1/waitlist");
        expect(entrypoint).toContain("/v1/admin/waitlist");
        expect(entrypoint).toContain("/v1/triggers/waitlist");
        expect(gitignore).not.toContain("gen/");
        expect(readme).not.toContain("Local introspection");
      }
      expect(entrypoint).toContain(variant.framework === "hono" ? "Hono" : "connectNodeAdapter");
      expect(readme).toContain("/webhooks/:provider");
      expect(readme).toContain("microservice profile");
      expect(readme).toContain("waitlist/launch service");
      expect(readme).toContain("resource=api://<resource_server_id>");
      expect(readme).toContain("Terraform is optional");
      expect(readme).toContain("AUTH_ENABLED=true");
      expect(readme).toContain("verifies JWT bearer tokens");
      expect(readme).toContain("prod/apps/auth/authctl/cloudflare-access");
      expect(readme).toContain(variant.runtime === "bun" ? "bun run auth -- resource-server" : 'make auth ARGS="resource-server"');
    }

    const deployWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "deploy.yml")).text();
    expect(deployWorkflow).toContain("bun run dashboards");
  }
}, 30000);

test("scaffolds a backend package cleanly into a nested monorepo-style directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-monorepo-"));
  const generatedRoot = join(root, "apps", "dns-api");

  await scaffoldProject(
    baseConfig({
      directory: generatedRoot,
      runtime: "bun",
      framework: "hono",
    })
  );

  const readme = await Bun.file(join(generatedRoot, "README.md")).text();
  expect(readme).toContain("`microservice` profile");
  expect(readme).toContain("api.dns-api.anmho.com");
  expect(readme).toContain("open Docker Desktop if needed");
  expect(readme).toContain("local Postgres service in `docker-compose.yml`");
  expect(readme).toContain("gcloud auth login");
  expect(readme).toContain("known-good CLIs");
  expect(readme).toContain("bun run create");
  expect(readme).toContain("bun run deploy");
  expect(readme).toContain("one-command production create");
  expect(readme).toContain("waitlist/launch service");
  expect(readme).toContain("Terraform is optional");
  expect(readme).toContain("waitlist/launch service");
  expect(readme).not.toContain("Neon main, preview, and personal branch provisioning");
  const ciWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "ci.yml")).text();
  expect(ciWorkflow).toContain("bun run dashboards");
  expect(readme).not.toContain("repository");

  const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
  expect(packageJson).toContain('"hono"');

  const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
  expect(entrypoint).toContain("/v1/waitlist");
  expect(entrypoint).toContain("/v1/admin/waitlist");
}, 15000);

test("scaffolds the workers target with wrangler lifecycle commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-workers-"));
  const generatedRoot = join(root, "edge-api");

  await scaffoldProject(
    baseConfig({
      directory: generatedRoot,
      target: "workers",
      runtime: "bun",
      framework: "hono",
    })
  );

  const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
  expect(packageJson).toContain('"@anmho/authctl": "0.1.1"');
  expect(packageJson).toContain('"service": "./scripts/workers/cli.ts"');
  expect(packageJson).toContain('"dev": "wrangler dev"');
  expect(packageJson).toContain('"auth": "bun run ./scripts/workers/cli.ts auth"');
  expect(packageJson).toContain('"wrangler"');
  expect(packageJson).toContain('"pg"');

  const wranglerConfig = await Bun.file(join(generatedRoot, "wrangler.toml")).text();
  expect(wranglerConfig).toContain('name = "dns-api"');
  expect(wranglerConfig).toContain('compatibility_flags = ["nodejs_compat"]');
  expect(wranglerConfig).toContain('pattern = "api.dns-api.anmho.com/*"');
  expect(wranglerConfig).toContain('binding = "HYPERDRIVE"');
  expect(wranglerConfig).toContain('AUTH_ENABLED = "true"');
  expect(wranglerConfig).toContain('AUTH_AUDIENCE = "api://dns-api"');

  const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
  expect(entrypoint).toContain("/v1/waitlist");
  expect(entrypoint).toContain("/v1/admin/waitlist");
  expect(entrypoint).toContain('app.use("/v1/*", authMiddleware())');
  expect(entrypoint).toContain("createStorage(context.env)");
  expect(entrypoint).toContain("scheduled");
  const readme = await Bun.file(join(generatedRoot, "README.md")).text();
  expect(readme).toContain("Cloudflare Workers");
  expect(readme).toContain("Hyperdrive binding for Neon-backed Postgres persistence");
  expect(readme).not.toContain("Cloud Run");
  const workerCli = await Bun.file(join(generatedRoot, "scripts", "workers", "cli.ts")).text();
  expect(workerCli).toContain("hyperdrive");
  expect(workerCli).toContain('["resources", "push", "--path", "./grafana"]');
  expect(workerCli).toContain("ensureAuthResourceServer");
  expect(workerCli).toContain("Workers database schema applied");
  expect(workerCli).toContain("create table if not exists waitlist_entries");
  expect(workerCli).toContain("DATABASE_URL or NEON_API_KEY is required to provision the Hyperdrive binding");
  expect(workerCli).toContain("createProjectBranchDatabase");
  expect(workerCli).toContain("deleteNeonDatabase");
  expect(workerCli).toContain("deleteGrafanaResources");
  expect(workerCli).toContain("hyperdrive\", \"delete");
  const makefile = await Bun.file(join(generatedRoot, "Makefile")).text();
  expect(makefile).toContain('no generated code for workers');
  expect(makefile).toContain("auth:");
  expect(makefile).not.toContain("scripts/codegen.ts");

  expect(await Bun.file(join(generatedRoot, "scripts", "authctl.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "src", "auth.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "src", "storage.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "scripts", "workers", "cli.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "scripts", "cloudrun", "cli.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "dev.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "ensure-local-db.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "local-docker.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "wait-for-db.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "service.yaml")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "Dockerfile")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "docker-compose.yml")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "src", "db", "repository.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "src", "temporal", "worker.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "codegen.ts")).exists()).toBeFalse();
});

test("microservice profile does not generate a website package", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-microservice-profile-"));
  const generatedRoot = join(root, "service");

  await scaffoldProject(baseConfig({ directory: generatedRoot, profile: "microservice" }));

  expect(await Bun.file(join(generatedRoot, "website", "package.json")).exists()).toBeFalse();
});

test("detects conflicting files before scaffold generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-conflict-"));
  const generatedRoot = join(root, "existing");
  await mkdir(generatedRoot, { recursive: true });
  await writeFile(join(generatedRoot, "README.md"), "hello");

  await expect(assertTargetDirectoryIsEmpty(generatedRoot)).rejects.toBeInstanceOf(DirectoryConflictError);
});
