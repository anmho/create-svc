import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, type ScaffoldConfig } from "../../scaffold";

function baseConfig(directory: string): ScaffoldConfig {
  return {
    directory,
    serviceName: "sdk-proof",
    modulePath: "github.com/anmho/sdk-proof",
    target: "cloudrun",
    runtime: "go",
    framework: "connectrpc",
    region: "us-west1",
    gcpProjectMode: "use_existing",
    gcpProject: "anmho-services",
    gcpProjectName: "services",
    billingAccount: "",
    quotaProjectId: "anmho-infra-prod",
    profile: "microservice",
    git: {
      enabled: false,
      owner: "anmho",
      repository: "sdk-proof",
    },
    neonDatabaseName: "sdk_proof",
    apiHostname: "api.sdk-proof.anmho.com",
    generatorRoot: join(import.meta.dir, "..", "..", ".."),
    autoDeploy: false,
  };
}

test("service sdk publish pushes the named Buf module and selects remote SDK mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-sdk-"));
  const generatedRoot = join(root, "sdk-proof");
  const fakeBin = join(root, "bin");
  const bufLog = join(root, "buf.log");

  await scaffoldProject(baseConfig(generatedRoot));
  await mkdir(join(generatedRoot, "node_modules"));
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "buf"),
    ["#!/bin/sh", `echo "$@" > "${bufLog}"`, "exit 0", ""].join("\n")
  );
  await chmod(join(fakeBin, "buf"), 0o755);

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "index.ts"), "sdk", "publish"], {
    cwd: generatedRoot,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.success, [result.stdout.toString(), result.stderr.toString()].join("\n")).toBeTrue();
  expect(result.stdout.toString()).toContain("recorded for consumers");
  expect((await readFile(bufLog, "utf8")).trim()).toBe("push");
  const sdkState = JSON.parse(await Bun.file(join(generatedRoot, ".service", "sdk.json")).text());
  expect(sdkState).toMatchObject({
    mode: "remote",
    module: "buf.build/anmho/sdk-proof",
    localPath: "./gen/waitlist/v1",
  });
  const bufConfig = await Bun.file(join(generatedRoot, "buf.yaml")).text();
  expect(bufConfig).toContain("name: buf.build/anmho/sdk-proof");
});

test("service sdk publish leaves local SDK mode when Buf push fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-sdk-"));
  const generatedRoot = join(root, "sdk-proof");
  const fakeBin = join(root, "bin");

  await scaffoldProject(baseConfig(generatedRoot));
  await mkdir(join(generatedRoot, "node_modules"));
  await mkdir(fakeBin);
  await mkdir(join(generatedRoot, ".service"));
  await Bun.write(
    join(generatedRoot, ".service", "sdk.json"),
    `${JSON.stringify(
      {
        mode: "local",
        module: "buf.build/anmho/sdk-proof",
        localPath: "./gen/waitlist/v1",
        updatedAt: "2026-05-25T00:00:00.000Z",
      },
      null,
      2
    )}\n`
  );
  await writeFile(join(fakeBin, "buf"), ["#!/bin/sh", "echo denied >&2", "exit 1", ""].join("\n"));
  await chmod(join(fakeBin, "buf"), 0o755);

  const before = JSON.parse(await Bun.file(join(generatedRoot, ".service", "sdk.json")).text());
  expect(before.mode).toBe("local");

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "index.ts"), "sdk", "publish"], {
    cwd: generatedRoot,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.success).toBeFalse();
  const after = JSON.parse(await Bun.file(join(generatedRoot, ".service", "sdk.json")).text());
  expect(after.mode).toBe("local");
});
