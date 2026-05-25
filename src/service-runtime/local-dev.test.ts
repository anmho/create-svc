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

  test("stops service-owned listeners when the pid file is missing", async () => {
    if (!Bun.which("lsof")) {
      return;
    }

    const root = await tempRoot();
    const port = await reservePort();
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        "Bun.serve({ port: Number(Bun.env.PORT), fetch() { return new Response('ok'); } }); setInterval(() => {}, 1000);",
      ],
      {
        cwd: root,
        env: { ...process.env, PORT: String(port) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (!child.pid) {
      throw new Error("spawned local dev process has no pid");
    }

    try {
      await waitForServer(port);

      const result = await stopLocalDev({ root, dockerCompose: false, ports: [port] });

      expect(result).toContain(`Stopped local dev process ${child.pid} on port ${port}`);
      await waitForListenerStop(port, child.pid);
    } finally {
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }
  }, 10_000);

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

async function reservePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  if (!port) {
    throw new Error("failed to reserve a local port");
  }
  await server.stop();
  return port;
}

async function waitForServer(port: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isReachable(port)) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`server on port ${port} did not start`);
}

async function waitForListenerStop(port: number, pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!listenerHasPid(port, pid)) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`process ${pid} on port ${port} did not stop listening`);
}

async function isReachable(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(250) });
    await response.text();
    return true;
  } catch {
    return false;
  }
}

function listenerHasPid(port: number, pid: number) {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success || !result.stdout) {
    return false;
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .includes(`p${pid}`);
}
