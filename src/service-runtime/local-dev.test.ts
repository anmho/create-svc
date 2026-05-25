import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLocalDevCleanupPlan, stopLocalDev } from "./local-dev";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local dev cleanup", () => {
  test("is idempotent with a missing pid and missing compose file", async () => {
    const root = await tempRoot();
    const result = await stopLocalDev({ root, dockerCompose: true, removeVolumes: true });

    expect(result).toContain("No local dev pid file found");
    expect(await Bun.file(join(root, ".service", "local-dev.pid")).exists()).toBe(false);
  });

  test("removes a stale pid file", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".service"), { recursive: true });
    await Bun.write(join(root, ".service", "local-dev.pid"), "999999\n");

    const result = await stopLocalDev({ root, dockerCompose: false });

    expect(result).toContain("Removed stale local dev pid file for 999999");
    expect(await Bun.file(join(root, ".service", "local-dev.pid")).exists()).toBe(false);
  });

  test("plans Docker Compose cleanup when compose exists", async () => {
    const root = await tempRoot();
    await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");

    const plan = await buildLocalDevCleanupPlan({ root, dockerCompose: true });

    expect(plan.resources).toContain("Docker Compose containers, networks, and volumes");
  });
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "create-svc-local-dev-"));
  roots.push(root);
  return root;
}
