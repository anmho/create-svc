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
    modulePath: "github.com/anmho/dns-api",
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

    const serviceConfig = await Bun.file(join(generatedRoot, "service.jsonc")).text();
    expect(serviceConfig).toContain('"service_id": "dns-api"');
    expect(serviceConfig).toContain('"target": "cloudrun"');
    expect(serviceConfig).toContain('"profile": "microservice"');
    expect(serviceConfig).toContain('"domain": "waitlist"');
    expect(serviceConfig).toContain('"kind": "microservice"');
    expect(serviceConfig).toContain(`"runtime": "${variant.runtime}"`);
    expect(serviceConfig).toContain(`"framework": "${variant.framework}"`);
    expect(serviceConfig).toContain('"module": "buf.build/anmho-services/dns-api"');
    expect(serviceConfig).toContain('"cloudflare_vault_path": "prod/providers/cloudflare"');
    expect(serviceConfig).toContain('"issuer": "https://auth.anmho.com/api/auth"');
    expect(serviceConfig).toContain('"audience": "api://dns-api"');
    expect(serviceConfig).toContain('"vault_path_prefix": "prod/apps/dns-api/server/oauth-clients"');
    expect(serviceConfig).toContain('"api_key_secret_name": "dns-api-temporal-api-key"');
    expect(serviceConfig).toContain('"project_mode": "create_new"');
    expect(serviceConfig).toContain('"quota_project_id": "anmho-infra-prod"');
    expect(serviceConfig).toContain('"artifact_repository": "cloud-run"');
    expect(serviceConfig).toContain('"worker_min_instances": 0');
    expect(serviceConfig).not.toContain("cloudbuild.googleapis.com");
    expect(serviceConfig).toContain('"jwks_url": "https://auth.anmho.com/api/auth/jwks"');
    expect(serviceConfig).toContain('"git": {');
    expect(serviceConfig).toContain('"repository": "dns-api"');
    expect(serviceConfig).toContain('"delete_on_destroy": false');
    expect(serviceConfig).toContain('"project_id": ""');
    expect(serviceConfig).toContain('"base_branch_id": ""');
    expect(serviceConfig).toContain('"base_branch_name": "main"');
    expect(serviceConfig).toContain('"preview_branch_prefix": "dns-api-pr"');
    expect(serviceConfig).toContain('"hostname": "api.dns-api.anmho.com"');
    expect(serviceConfig).not.toContain("github:");
    expect(serviceConfig).not.toContain("attachmentBucket");
    expect(await Bun.file(join(generatedRoot, "scripts", "cloudrun", "integrations.ts")).exists()).toBeFalse();
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
    expect(manifest).toContain('autoscaling.knative.dev/minScale: "${SERVICE_MIN_SCALE}"');
    expect(manifest).not.toContain("CLERK_SECRET_KEY");
    expect(manifest).not.toContain("STRIPE_SECRET_KEY");
    expect(manifest).not.toContain("REVENUECAT_API_KEY");
    expect(manifest).not.toContain("RESEND_API_KEY");
    expect(manifest).not.toContain("POSTHOG_API_KEY");

    const gitignore = await Bun.file(join(generatedRoot, ".gitignore")).text();
    expect(gitignore).toContain("node_modules");
    expect(gitignore).toContain(".service/*.log");
    expect(gitignore).toContain(".wrangler");
    expect(await Bun.file(join(generatedRoot, "website", "package.json")).exists()).toBeFalse();

    const dockerCompose = await Bun.file(join(generatedRoot, "docker-compose.yml")).text();
    expect(dockerCompose).toContain('image: postgres:16-alpine');
    expect(dockerCompose).toContain(`127.0.0.1:${localPort}:5432`);

    const envExample = await Bun.file(join(generatedRoot, ".env.example")).text();
    expect(envExample).toContain(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${localPort}/dns_api?sslmode=disable`);
    expect(envExample).toContain("AUTH_ENABLED=false");
    expect(envExample).toContain("AUTH_AUDIENCE=api://dns-api");
    expect(envExample).toContain("CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_ID=");
    expect(envExample).toContain("VAULT_AUTHCTL_ACCESS_PATH=prod/apps/auth/authctl/cloudflare-access");
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
    expect(localEnv).toContain("VAULT_AUTHCTL_ACCESS_PATH=prod/apps/auth/authctl/cloudflare-access");
    expect(localEnv).toContain("VAULT_NEON_API_KEY_PATH=prod/providers/neon");
    expect(localEnv).toContain("VAULT_CLOUDFLARE_API_TOKEN_PATH=prod/providers/cloudflare");
    expect(localEnv).not.toContain("ATTACHMENT_PUBLIC_BASE_URL=");

    expect(await Bun.file(join(generatedRoot, "grafana", "waitlist-dashboard.json")).exists()).toBeTrue();
    expect(await Bun.file(join(generatedRoot, "grafana", "alerts.yaml")).exists()).toBeTrue();

    const ciWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "ci.yml")).text();
    expect(ciWorkflow).not.toContain("go install github.com/bufbuild/buf/cmd/buf@latest");
    if (variant.runtime === "go" && variant.framework === "connectrpc") {
      expect(ciWorkflow).toContain("bufbuild/buf-setup-action@v1");
      expect(ciWorkflow).toContain('version: "1.60.0"');
      expect(ciWorkflow).toContain("'connectrpc' == 'connectrpc'");
    }
    if (variant.runtime === "go" && variant.framework === "chi") {
      expect(ciWorkflow).toContain("'chi' == 'connectrpc'");
    }

    const previewWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "preview.yml")).text();
    expect(previewWorkflow).toContain("issue_comment:");
    expect(previewWorkflow).toContain("/deploy preview");
    expect(previewWorkflow).not.toContain("branches-ignore:");
    expect(previewWorkflow).toContain("service deploy --ci --environment preview --name");
    expect(previewWorkflow).toContain("steps.pr.outputs.number");
    expect(previewWorkflow).toContain("NEON_API_KEY");
    expect(previewWorkflow).toContain("CLOUDFLARE_API_TOKEN");
    if (variant.runtime === "go") {
      expect(previewWorkflow).toContain("ariga/setup-atlas");
    }

    const previewCleanupWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "preview-cleanup.yml")).text();
    expect(previewCleanupWorkflow).toContain("pull_request:");
    expect(previewCleanupWorkflow).toContain("types: [closed]");
    expect(previewCleanupWorkflow).toContain("github.event.pull_request.number");

    const deployWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "deploy.yml")).text();
    expect(deployWorkflow).toContain("branches:");
    expect(deployWorkflow).toContain("- main");
    if (variant.runtime === "go") {
      expect(deployWorkflow).toContain("ariga/setup-atlas");
    }
    expect(deployWorkflow).toContain("gcloud components install beta --quiet");
    expect(deployWorkflow).toContain("bun install -g create-svc@latest");
    expect(deployWorkflow).toContain("service deploy --ci");
    expect(deployWorkflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(deployWorkflow).toContain("bun run dashboards");
    expect(deployWorkflow).toContain("GCX_ENABLED");

    const personalWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "personal.yml")).text();
    expect(personalWorkflow).toContain("workflow_dispatch:");
    expect(personalWorkflow).toContain("service deploy --ci --environment personal --name");
    expect(personalWorkflow).toContain("service deploy --ci --destroy --environment personal --name");
    if (variant.runtime === "go") {
      expect(personalWorkflow).toContain("ariga/setup-atlas");
    }

    if (variant.runtime === "go") {
      const goMod = await Bun.file(join(generatedRoot, "go.mod")).text();
      const goSumExists = await Bun.file(join(generatedRoot, "go.sum")).exists();
      const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
      expect(goMod).toContain("module github.com/anmho/dns-api");
      expect(goMod).not.toContain("module example.com/dns-api");
      expect(goSumExists).toBeTrue();
      const dockerfile = await Bun.file(join(generatedRoot, "Dockerfile")).text();
      expect(dockerfile).toContain("COPY go.mod go.sum ./");
      if (variant.framework === "chi") {
        expect(dockerfile).not.toContain("COPY gen ./gen");
      } else {
        expect(dockerfile).toContain("COPY gen ./gen");
      }
      expect(packageJson).toContain('"dev": "make dev"');
      expect(packageJson).toContain('"service": "service"');
      expect(packageJson).toContain('"migrate": "service migrate"');
      expect(packageJson).toContain('"create": "service create"');
      expect(packageJson).toContain('"deploy": "service deploy"');
      expect(packageJson).toContain('"protect-main": "service protect-main"');
      expect(packageJson).toContain('"destroy": "service destroy"');

      const mainGo = await Bun.file(join(generatedRoot, "cmd", "server", "main.go")).text();
      expect(mainGo).toContain("github.com/anmho/dns-api");
      if (variant.framework === "connectrpc") {
        expect(goMod).toContain("connectrpc.com/connect");
        expect(mainGo).toContain("NewWaitlistService");
        expect(mainGo).toContain("WaitlistServiceName");
        const bufConfig = await Bun.file(join(generatedRoot, "buf.yaml")).text();
        expect(bufConfig).toContain("name: buf.build/anmho-services/dns-api");
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
      expect(makefile).toContain("bun run ./scripts/dev.ts go run ./cmd/server --worker go run ./cmd/worker");
      expect(makefile).toContain("protect-main:");
      expect(makefile).toContain("$(SERVICE) protect-main");
      expect(await Bun.file(join(generatedRoot, "atlas.hcl")).exists()).toBeTrue();
      const atlasConfig = await Bun.file(join(generatedRoot, "atlas.hcl")).text();
      expect(atlasConfig).toContain('revisions_schema = "public"');
      expect(await Bun.file(join(generatedRoot, "migrations", "atlas.sum")).exists()).toBeTrue();
      expect(await Bun.file(join(generatedRoot, "cmd", "migrate", "main.go")).exists()).toBeFalse();
      expect(await Bun.file(join(generatedRoot, "internal", "temporal", "worker.go")).exists()).toBeTrue();
      expect(goMod).toContain("go.temporal.io/sdk");
    } else {
      const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
      expect(packageJson).toContain('"@anmho/authctl": "0.1.1"');
      expect(packageJson).toContain("@temporalio/worker");
      expect(packageJson).toContain('"dev": "bun run ./scripts/dev.ts bun run ./src/index.ts --worker bun run ./src/worker.ts"');
      expect(packageJson).toContain('"gen": "bun run ./scripts/codegen.ts"');
      expect(packageJson).toContain('"service": "service"');
      expect(packageJson).toContain('"migrate": "service migrate"');
      expect(packageJson).toContain('"create": "service create"');
      expect(packageJson).toContain('"deploy": "service deploy"');
      expect(packageJson).toContain('"protect-main": "service protect-main"');
      expect(packageJson).toContain('"dashboards": "service dashboards"');
      expect(packageJson).toContain('"observability-bootstrap": "service observability-bootstrap"');
      expect(packageJson).toContain('"auth": "service auth"');
      expect(packageJson).toContain('"destroy": "service destroy"');
      expect(await Bun.file(join(generatedRoot, "scripts", "cloudrun", "cli.ts")).exists()).toBeFalse();
      expect(await Bun.file(join(generatedRoot, "scripts", "authctl.ts")).exists()).toBeFalse();
      const serviceConfig = await Bun.file(join(generatedRoot, "service.jsonc")).text();
      expect(serviceConfig).toContain('"service_id": "dns-api"');
      expect(serviceConfig).toContain('"project_id": "anmho-dns-api"');
      expect(serviceConfig).toContain('"database_name": "dns_api"');
      expect(serviceConfig).toContain('"observability"');
      expect(serviceConfig).toContain("logging.googleapis.com");
      const authScript = await Bun.file(join(generatedRoot, "src", "auth.ts")).text();
      expect(authScript).toContain('"Ed25519"');

      const makefile = await Bun.file(join(generatedRoot, "Makefile")).text();
      expect(makefile).toContain("SERVICE := service");
      expect(makefile).toContain("dashboards:");
      expect(makefile).toContain("observability-bootstrap:");
      expect(makefile).toContain("protect-main:");
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
      expect(readme).toContain("service auth resource-server");
      expect(readme).toContain("GitHub main branch protection");
      expect(readme).toContain("service create");
      expect(readme).toContain("service protect-main");
    }

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
  expect(readme).toContain("service create");
  expect(readme).toContain("service deploy");
  expect(readme).toContain("Google observability bootstrap");
  expect(readme).toContain("Google Cloud Logging, Monitoring, and Trace APIs");
  expect(readme).toContain("one-command production create");
  expect(readme).toContain("waitlist/launch service");
  expect(readme).toContain("Terraform is optional");
  expect(readme).toContain("waitlist/launch service");
  expect(readme).not.toContain("Neon main, preview, and personal branch provisioning");
  expect(readme).toContain("GitHub Actions deployment");
  expect(readme).toContain("GitHub main branch protection");
  expect(readme).toContain("service protect-main");
  expect(readme).toContain(".github/workflows/preview.yml");
  expect(readme).toContain(".github/workflows/deploy.yml");
  expect(readme).toContain("/deploy preview");
  expect(readme).toContain("GCP_WIF_PROVIDER");
  expect(readme).toContain("GCP_DEPLOYER_SERVICE_ACCOUNT");
  expect(readme).toContain("NEON_API_KEY");
  expect(readme).toContain("CLOUDFLARE_API_TOKEN");
  expect(readme).toContain("ConnectRPC service builds import the generated bindings checked into this repo");
  expect(readme).toContain("does not rewrite this");
  expect(readme).toContain("service's Go imports away from local generated packages");

  const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
  expect(packageJson).toContain('"hono"');

  const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
  expect(entrypoint).toContain("/v1/waitlist");
  expect(entrypoint).toContain("/v1/admin/waitlist");
  expect(await Bun.file(join(generatedRoot, ".github", "workflows", "preview.yml")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, ".github", "workflows", "deploy.yml")).exists()).toBeTrue();
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
  expect(packageJson).toContain('"dev": "bun run ./scripts/dev.ts wrangler dev --ip 127.0.0.1 --port 8787 --show-interactive-dev-session=false"');
  expect(packageJson).toContain('"service": "service"');
  expect(packageJson).toContain('"protect-main": "service protect-main"');
  expect(packageJson).toContain('"auth": "service auth"');
  expect(packageJson).toContain('"wrangler"');
  expect(packageJson).toContain('"pg"');
  expect(packageJson).toContain('"@trigger.dev/sdk"');
  expect(packageJson).toContain('"trigger.dev"');
  expect(packageJson).toContain('"trigger": "trigger"');
  expect(packageJson).toContain('"trigger:dev": "trigger dev"');
  expect(packageJson).toContain('"trigger:deploy": "trigger deploy"');

  const wranglerConfig = await Bun.file(join(generatedRoot, "wrangler.toml")).text();
  expect(wranglerConfig).toContain('name = "dns-api"');
  expect(wranglerConfig).toContain('compatibility_flags = ["nodejs_compat"]');
  expect(wranglerConfig).toContain('pattern = "api.dns-api.anmho.com"');
  expect(wranglerConfig).toContain('binding = "HYPERDRIVE"');
  expect(wranglerConfig).toContain('AUTH_ENABLED = "true"');
  expect(wranglerConfig).toContain('AUTH_AUDIENCE = "api://dns-api"');
  expect(wranglerConfig).toContain('TRIGGER_TASK_ID = "dns-api-waitlist-follow-up"');
  expect(wranglerConfig).toContain('TRIGGER_API_URL = "https://api.trigger.dev"');
  expect(wranglerConfig).not.toContain("[triggers]");
  expect(wranglerConfig).not.toContain("crons");
  const authSource = await Bun.file(join(generatedRoot, "src", "auth.ts")).text();
  expect(authSource).toContain('alg === "EdDSA"');
  expect(authSource).toContain('name: "Ed25519"');

  const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
  expect(entrypoint).toContain("/v1/waitlist");
  expect(entrypoint).toContain("/v1/admin/waitlist");
  expect(entrypoint).toContain('app.use("/v1/*", authMiddleware())');
  expect(entrypoint).toContain("createStorage(context.env)");
  expect(entrypoint).toContain("dispatchWaitlistFollowUp");
  expect(entrypoint).not.toContain("scheduled");
  const readme = await Bun.file(join(generatedRoot, "README.md")).text();
  expect(readme).toContain("Cloudflare Workers");
  expect(readme).toContain("Hyperdrive binding for Neon-backed Postgres persistence");
  expect(readme).toContain("Trigger.dev task dispatch");
  expect(readme).not.toContain("Cloud Run");
  const serviceConfig = await Bun.file(join(generatedRoot, "service.jsonc")).text();
  expect(serviceConfig).toContain('"target": "workers"');
  expect(serviceConfig).toContain('"hostname": "api.dns-api.anmho.com"');
  expect(serviceConfig).toContain('"database_name": "dns_api"');
  expect(serviceConfig).toContain('"trigger_dev"');
  expect(serviceConfig).toContain('"access_token_env": "TRIGGER_ACCESS_TOKEN"');
  expect(serviceConfig).toContain('"waitlist_task_id": "dns-api-waitlist-follow-up"');
  const makefile = await Bun.file(join(generatedRoot, "Makefile")).text();
  expect(makefile).toContain('no generated code for workers');
  expect(makefile).toContain("auth:");
  expect(makefile).toContain("protect-main:");
  expect(makefile).not.toContain("scripts/codegen.ts");

  expect(await Bun.file(join(generatedRoot, "scripts", "authctl.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "src", "auth.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "src", "storage.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "src", "trigger.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "trigger.config.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "trigger", "waitlist-follow-up.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "scripts", "workers", "cli.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "cloudrun", "cli.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "dev.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "scripts", "ensure-local-db.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "scripts", "local-docker.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "scripts", "wait-for-db.ts")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "service.yaml")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "Dockerfile")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "docker-compose.yml")).exists()).toBeTrue();
  expect(await Bun.file(join(generatedRoot, "src", "db", "repository.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "src", "temporal", "worker.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "src", "worker.ts")).exists()).toBeFalse();
  expect(await Bun.file(join(generatedRoot, "scripts", "codegen.ts")).exists()).toBeFalse();

  const previewWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "preview.yml")).text();
  expect(previewWorkflow).toContain("issue_comment:");
  expect(previewWorkflow).toContain("/deploy preview");
  expect(previewWorkflow).toContain("service deploy --name dns-api-pr-");
  expect(previewWorkflow).not.toContain("google-github-actions/auth");

  const previewCleanupWorkflow = await Bun.file(join(generatedRoot, ".github", "workflows", "preview-cleanup.yml")).text();
  expect(previewCleanupWorkflow).toContain("pull_request:");
  expect(previewCleanupWorkflow).toContain("wrangler delete --name dns-api-pr-");
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
