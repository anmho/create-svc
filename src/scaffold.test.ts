import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DirectoryConflictError, assertTargetDirectoryIsEmpty, scaffoldProject, type ScaffoldConfig } from "./scaffold";

function baseConfig(overrides: Partial<ScaffoldConfig> = {}): ScaffoldConfig {
  return {
    directory: "svc",
    serviceName: "dns-api",
    runtime: "bun",
    framework: "hono",
    region: "us-west1",
    gcpProjectMode: "create_new",
    gcpProject: "anmho-dns-api",
    gcpProjectName: "dns-api",
    billingAccount: "billingAccounts/01BD2E-3A6949-8F4C84",
    quotaProjectId: "anmho-infra-prod",
    neonProjectId: "project-123",
    neonBaseBranchId: "br-main",
    neonBaseBranchName: "main",
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

    await scaffoldProject(
      baseConfig({
        directory: generatedRoot,
        runtime: variant.runtime,
        framework: variant.framework,
      })
    );

    const configScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "config.ts")).text();
    expect(configScript).toContain(`runtime: "${variant.runtime}"`);
    expect(configScript).toContain(`framework: "${variant.framework}"`);
    expect(configScript).toContain('mode: "create_new"');
    expect(configScript).toContain('quotaProjectId: "anmho-infra-prod"');
    expect(configScript).toContain('projectId: "project-123"');
    expect(configScript).toContain('previewBranchPrefix: "dns-api-pr"');
    expect(configScript).toContain('hostname: "api.dns-api.anmho.com"');
    expect(configScript).not.toContain("github:");

    const deployScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "lib.ts")).text();
    expect(deployScript).toContain('--billing-project", config.project.quotaProjectId');
    expect(deployScript).toContain("serviceDomain");
    expect(deployScript).toContain("ensureProductionDomainMapping");

    expect(await Bun.file(join(generatedRoot, ".github", "workflows", "personal.yml")).exists()).toBeFalse();

    if (variant.runtime === "go") {
      const goMod = await Bun.file(join(generatedRoot, "go.mod")).text();
      expect(goMod).toContain("connectrpc.com/connect");

      const mainGo = await Bun.file(join(generatedRoot, "cmd", "server", "main.go")).text();
      expect(mainGo).toContain("NewDNSService");
    } else {
      const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
      expect(packageJson).toContain('"svc-cloudrun": "./scripts/cloudrun/cli.ts"');

      const makefile = await Bun.file(join(generatedRoot, "Makefile")).text();
      expect(makefile).toContain("npx --no-install svc-cloudrun");

      const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
      if (variant.framework === "connectrpc") {
        expect(entrypoint).toContain("DNSService");
      } else {
        expect(entrypoint).toContain("rpc.example.v1.Service/Ping");
      }
      expect(entrypoint).toContain(variant.framework === "hono" ? "Hono" : "connectNodeAdapter");
    }
  }
});

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
  expect(readme).toContain("backend bootstrap");
  expect(readme).toContain("api.dns-api.anmho.com");
  expect(readme).toContain("gcloud auth login");
  expect(readme).toContain("known-good CLIs");
  expect(readme).not.toContain("GitHub Actions");
  expect(readme).not.toContain("repository");

  const packageJson = await Bun.file(join(generatedRoot, "package.json")).text();
  expect(packageJson).toContain('"hono"');

  const entrypoint = await Bun.file(join(generatedRoot, "src", "index.ts")).text();
  expect(entrypoint).toContain("rpc.example.v1.Service/Ping");

  expect(await Bun.file(join(generatedRoot, ".github", "workflows", "ci.yml")).exists()).toBeFalse();
});

test("detects conflicting files before scaffold generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-conflict-"));
  const generatedRoot = join(root, "existing");
  await mkdir(generatedRoot, { recursive: true });
  await writeFile(join(generatedRoot, "README.md"), "hello");

  await expect(assertTargetDirectoryIsEmpty(generatedRoot)).rejects.toBeInstanceOf(DirectoryConflictError);
});
