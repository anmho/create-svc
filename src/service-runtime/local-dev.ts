import { rm } from "node:fs/promises";
import { join } from "node:path";

type LocalDevOptions = {
  root?: string;
  dockerCompose?: boolean;
  removeVolumes?: boolean;
};

export type LocalDevCleanupPlan = {
  pidFile: string;
  hasPidFile: boolean;
  pid?: number;
  hasDockerCompose: boolean;
  resources: string[];
  skipped: string[];
};

const decoder = new TextDecoder();

export async function buildLocalDevCleanupPlan(options: LocalDevOptions = {}): Promise<LocalDevCleanupPlan> {
  const root = options.root ?? defaultServiceRoot();
  const pidFile = join(root, ".service", "local-dev.pid");
  const hasPidFile = await Bun.file(pidFile).exists();
  const pid = hasPidFile ? parsePid(await Bun.file(pidFile).text()) : undefined;
  const hasDockerCompose = Boolean(options.dockerCompose) && (await Bun.file(join(root, "docker-compose.yml")).exists());
  const resources: string[] = [];
  const skipped: string[] = [];

  if (hasPidFile) {
    resources.push(`Local dev process from ${pidFile}`);
  } else {
    skipped.push("Local dev process: no .service/local-dev.pid");
  }

  if (hasDockerCompose) {
    resources.push("Docker Compose containers, networks, and volumes");
  } else if (options.dockerCompose) {
    skipped.push("Docker Compose: no docker-compose.yml");
  }

  return {
    pidFile,
    hasPidFile,
    pid,
    hasDockerCompose,
    resources,
    skipped,
  };
}

export async function stopLocalDev(options: LocalDevOptions = {}) {
  const root = options.root ?? defaultServiceRoot();
  const plan = await buildLocalDevCleanupPlan({ ...options, root });
  const messages: string[] = [];

  if (plan.hasPidFile) {
    if (plan.pid) {
      messages.push(stopPid(plan.pid) ? `Stopped local dev process ${plan.pid}` : `Removed stale local dev pid file for ${plan.pid}`);
    } else {
      messages.push(`Removed invalid local dev pid file ${plan.pidFile}`);
    }
    await rm(plan.pidFile, { force: true });
  } else {
    messages.push("No local dev pid file found");
  }

  if (plan.hasDockerCompose) {
    const result = runDockerComposeDown(root, Boolean(options.removeVolumes));
    messages.push(result);
  }

  return messages.join("\n");
}

function defaultServiceRoot() {
  return process.env.CREATE_SVC_SERVICE_ROOT?.trim() || process.cwd();
}

function parsePid(raw: string) {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function stopPid(pid: number) {
  const wasRunning = isRunning(pid);
  tryKill(-pid, "SIGTERM") || tryKill(pid, "SIGTERM");
  Bun.sleepSync(1_000);
  if (isRunning(pid)) {
    tryKill(-pid, "SIGKILL") || tryKill(pid, "SIGKILL");
  }
  return wasRunning;
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryKill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function runDockerComposeDown(root: string, removeVolumes: boolean) {
  if (!Bun.which("docker")) {
    return "Docker is not installed; Docker Compose cleanup skipped";
  }

  const args = ["compose", "down", "--remove-orphans"];
  if (removeVolumes) {
    args.push("-v");
  }
  const result = Bun.spawnSync(["docker", ...args], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    const output = [
      result.stderr ? decoder.decode(result.stderr).trim() : "",
      result.stdout ? decoder.decode(result.stdout).trim() : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `Docker Compose cleanup failed: ${output || `exit ${result.exitCode}`}`;
  }
  return removeVolumes ? "Docker Compose containers and volumes removed" : "Docker Compose containers stopped";
}
