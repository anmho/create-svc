import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DirectoryConflictError, assertTargetDirectoryIsEmpty, scaffoldProject, type ScaffoldConfig } from "./scaffold";

function baseConfig(overrides: Partial<ScaffoldConfig> = {}): ScaffoldConfig {
  return {
    directory: "svc",
    serviceName: "dns-api",
    runtime: "go",
    framework: "chi",
    region: "us-west1",
    gcpProjectMode: "create_new",
    gcpProject: "anmho-dns-api",
    gcpProjectName: "dns-api",
    billingAccount: "billingAccounts/01BD2E-3A6949-8F4C84",
    quotaProjectId: "anmho-infra-prod",
    githubRepo: "anmho/dns-api",
    githubVisibility: "public",
    createGithubRepo: true,
    autoDeploy: false,
    neonProjectId: "project-123",
    neonBaseBranchId: "br-main",
    neonBaseBranchName: "main",
    neonDatabaseName: "dns_api",
    generatorRoot: join(import.meta.dir, ".."),
    ...overrides,
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

    const deployScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "lib.ts")).text();
    expect(deployScript).toContain('--billing-project", config.project.quotaProjectId');

    const workflow = await Bun.file(join(generatedRoot, ".github", "workflows", "personal.yml")).text();
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("--environment personal");

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
      expect(entrypoint).toContain(variant.framework === "hono" ? "Hono" : "rpc.example.v1.Service/Ping");
    }
  }
});

test("detects conflicting files before scaffold generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-conflict-"));
  const generatedRoot = join(root, "existing");
  await mkdir(generatedRoot, { recursive: true });
  await writeFile(join(generatedRoot, "README.md"), "hello");

  await expect(assertTargetDirectoryIsEmpty(generatedRoot)).rejects.toBeInstanceOf(DirectoryConflictError);
});
