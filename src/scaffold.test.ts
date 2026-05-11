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
    runtime: "bun",
    framework: "hono",
    region: "us-west1",
    gcpProjectMode: "create_new",
    gcpProject: "anmho-dns-api",
    gcpProjectName: "dns-api",
    billingAccount: "billingAccounts/01BD2E-3A6949-8F4C84",
    quotaProjectId: "anmho-infra-prod",
    profile: "microservice",
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
    expect(configScript).toContain('profile: "microservice"');
    expect(configScript).toContain('domain: "waitlist"');
    expect(configScript).toContain('kind: "microservice"');
    expect(configScript).toContain(`runtime: "${variant.runtime}"`);
    expect(configScript).toContain(`framework: "${variant.framework}"`);
    expect(configScript).toContain('mode: "create_new"');
    expect(configScript).toContain('quotaProjectId: "anmho-infra-prod"');
    expect(configScript).toContain('projectId: ""');
    expect(configScript).toContain('baseBranchId: ""');
    expect(configScript).toContain('baseBranchName: "main"');
    expect(configScript).toContain('previewBranchPrefix: "dns-api-pr"');
    expect(configScript).toContain('hostname: "api.dns-api.anmho.com"');
    expect(configScript).toContain('attachmentBucket: "anmho-dns-api-dns-api-attachments"');
    expect(configScript).toContain('attachmentPublicBaseUrl: "https://storage.googleapis.com/anmho-dns-api-dns-api-attachments"');
    expect(configScript).not.toContain("github:");

    const deployScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "lib.ts")).text();
    expect(deployScript).toContain('--billing-project", config.project.quotaProjectId');
    expect(deployScript).toContain("serviceDomain");
    expect(deployScript).toContain("ensureProductionDomainMapping");
    expect(deployScript).toContain("ensureStorageBucket");

    const bootstrapScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "bootstrap.ts")).text();
    expect(bootstrapScript).toContain("publishProviderRuntimeSecrets");

    const manifest = await Bun.file(join(generatedRoot, "service.yaml")).text();
    expect(manifest).toContain("CLERK_SECRET_KEY");
    expect(manifest).toContain("STRIPE_SECRET_KEY");
    expect(manifest).toContain("REVENUECAT_API_KEY");
    expect(manifest).toContain("RESEND_API_KEY");
    expect(manifest).toContain("POSTHOG_API_KEY");

    const gitignore = await Bun.file(join(generatedRoot, ".gitignore")).text();
    expect(gitignore).toContain("node_modules");
    expect(await Bun.file(join(generatedRoot, "website", "package.json")).exists()).toBeFalse();

    const dockerCompose = await Bun.file(join(generatedRoot, "docker-compose.yml")).text();
    expect(dockerCompose).toContain('image: postgres:16-alpine');
    expect(dockerCompose).toContain(`127.0.0.1:${localPort}:5432`);

    const envExample = await Bun.file(join(generatedRoot, ".env.example")).text();
    expect(envExample).toContain(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${localPort}/dns_api`);
    expect(envExample).toContain("ATTACHMENT_BUCKET=dns-api-local-attachments");
    expect(envExample).toContain("CLERK_SECRET_KEY=");
    expect(envExample).toContain("STRIPE_SECRET_KEY=");
    expect(envExample).toContain("REVENUECAT_API_KEY=");
    expect(envExample).toContain("RESEND_API_KEY=");
    expect(envExample).toContain("POSTHOG_API_KEY=");

    const localEnv = await Bun.file(join(generatedRoot, ".env.local")).text();
    expect(localEnv).toContain(`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${localPort}/dns_api`);
    expect(localEnv).toContain("ATTACHMENT_PUBLIC_BASE_URL=https://storage.local.invalid/dns-api-local-attachments");

    expect(await Bun.file(join(generatedRoot, ".github", "workflows", "personal.yml")).exists()).toBeFalse();

    if (variant.runtime === "go") {
      const goMod = await Bun.file(join(generatedRoot, "go.mod")).text();
      expect(goMod).toContain("connectrpc.com/connect");
      expect(goMod).toContain("module example.com/dns-api");
      expect(goMod).not.toContain("module github.com/anmho/dns-api");

      const mainGo = await Bun.file(join(generatedRoot, "cmd", "server", "main.go")).text();
      expect(mainGo).toContain("NewChatService");
      expect(mainGo).toContain("example.com/dns-api");
    } else {
      const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
      expect(packageJson).toContain('"svc-cloudrun": "./scripts/cloudrun/cli.ts"');
      expect(packageJson).toContain('"dev": "bun run ./src/index.ts"');
      expect(packageJson).toContain('"gen": "bun run ./scripts/codegen.ts"');
      expect(packageJson).toContain('"bootstrap": "bun run ./scripts/cloudrun/cli.ts bootstrap"');
      expect(packageJson).toContain('"deploy": "bun run ./scripts/cloudrun/cli.ts deploy"');
      expect(packageJson).toContain('"cleanup": "bun run ./scripts/cloudrun/cli.ts cleanup"');

      const makefile = await Bun.file(join(generatedRoot, "Makefile")).text();
      expect(makefile).toContain("npx --no-install svc-cloudrun");

      const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
      const readme = await Bun.file(join(generatedRoot, "README.md")).text();
      if (variant.framework === "connectrpc") {
        expect(entrypoint).toContain("ChatService");
        expect(gitignore).toContain("gen/");
        expect(readme).toContain("Local introspection");
      } else {
        expect(entrypoint).toContain("/v1/conversations");
        expect(gitignore).not.toContain("gen/");
        expect(readme).not.toContain("Local introspection");
      }
      expect(entrypoint).toContain(variant.framework === "hono" ? "Hono" : "connectNodeAdapter");
      expect(readme).toContain("ATTACHMENT_BUCKET");
      expect(readme).toContain("/webhooks/:provider");
      expect(readme).toContain("microservice profile");
      expect(readme).toContain("waitlist/launch service");
      expect(readme).toContain("Terraform is optional");
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
  expect(readme).toContain("docker compose up -d");
  expect(readme).toContain("local Postgres service in `docker-compose.yml`");
  expect(readme).toContain("gcloud auth login");
  expect(readme).toContain("known-good CLIs");
  expect(readme).toContain("bun run bootstrap");
  expect(readme).toContain("bun run deploy");
  expect(readme).toContain("ATTACHMENT_BUCKET");
  expect(readme).toContain("one-command production bootstrap");
  expect(readme).toContain("waitlist/launch service");
  expect(readme).toContain("Terraform is optional");
  expect(readme).toContain("webhook_events");
  expect(readme).not.toContain("Neon main, preview, and personal branch provisioning");
  expect(readme).not.toContain("GitHub Actions");
  expect(readme).not.toContain("repository");

  const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
  expect(packageJson).toContain('"hono"');

  const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
  expect(entrypoint).toContain("/v1/attachments/uploads");

  expect(await Bun.file(join(generatedRoot, ".github", "workflows", "ci.yml")).exists()).toBeFalse();
}, 15000);

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
