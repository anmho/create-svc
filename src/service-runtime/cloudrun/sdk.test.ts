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
    [
      "#!/bin/sh",
      `echo "$@" >> "${bufLog}"`,
      'if [ "$1 $2 $3 $4" = "registry module commit list" ]; then',
      '  printf \'{"commits":[{"name":"buf.build/anmho/sdk-proof:commit-123","digest":"b5:abc123","create_time":"2026-05-25T12:00:00Z"}]}\'',
      "fi",
      "exit 0",
      "",
    ].join("\n")
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
  expect((await readFile(bufLog, "utf8")).trim()).toBe(
    ["push", "registry module commit list buf.build/anmho/sdk-proof --format json --page-size 1"].join("\n")
  );
  const sdkState = JSON.parse(await Bun.file(join(generatedRoot, ".service", "sdk.json")).text());
  expect(sdkState).toMatchObject({
    mode: "remote",
    module: "buf.build/anmho/sdk-proof",
    localPath: "./gen/waitlist/v1",
    remote: {
      commit: "commit-123",
      digest: "b5:abc123",
      createTime: "2026-05-25T12:00:00Z",
    },
  });
  const bufConfig = await Bun.file(join(generatedRoot, "buf.yaml")).text();
  expect(bufConfig).toContain("name: buf.build/anmho/sdk-proof");
});

test("service doctor reports the recorded remote SDK commit even when cloud checks fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-sdk-"));
  const generatedRoot = join(root, "sdk-proof");

  await scaffoldProject(baseConfig(generatedRoot));
  await mkdir(join(generatedRoot, "node_modules"));
  await mkdir(join(generatedRoot, ".service"));
  await Bun.write(
    join(generatedRoot, ".service", "sdk.json"),
    `${JSON.stringify(
      {
        mode: "remote",
        module: "buf.build/anmho/sdk-proof",
        localPath: "./gen/waitlist/v1",
        remote: {
          commit: "commit-123",
          digest: "b5:abc123",
        },
        updatedAt: "2026-05-25T00:00:00.000Z",
      },
      null,
      2
    )}\n`
  );

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "index.ts"), "doctor"], {
    cwd: generatedRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect([result.stdout.toString(), result.stderr.toString()].join("\n")).toContain(
    "SDK mode: remote: buf.build/anmho/sdk-proof@commit-123 (b5:abc123)"
  );
});

test("service sdk use-remote records the current Buf commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-sdk-"));
  const generatedRoot = join(root, "sdk-proof");
  const fakeBin = join(root, "bin");

  await scaffoldProject(baseConfig(generatedRoot));
  await mkdir(join(generatedRoot, "node_modules"));
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "buf"),
    [
      "#!/bin/sh",
      'if [ "$1 $2 $3 $4" = "registry module commit list" ]; then',
      '  printf \'{"commits":[{"name":"buf.build/anmho/sdk-proof:commit-456","digest":"b5:def456"}]}\'',
      "fi",
      "exit 0",
      "",
    ].join("\n")
  );
  await chmod(join(fakeBin, "buf"), 0o755);

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "..", "index.ts"), "sdk", "use-remote"], {
    cwd: generatedRoot,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.success, [result.stdout.toString(), result.stderr.toString()].join("\n")).toBeTrue();
  const sdkState = JSON.parse(await Bun.file(join(generatedRoot, ".service", "sdk.json")).text());
  expect(sdkState).toMatchObject({
    mode: "remote",
    remote: {
      commit: "commit-456",
      digest: "b5:def456",
    },
  });
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
