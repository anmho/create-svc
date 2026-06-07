import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";

type LocalDevOptions = {
  root?: string;
  dockerCompose?: boolean;
  removeVolumes?: boolean;
  ports?: number[];
};

export type LocalDevCleanupPlan = {
  pidFile: string;
  hasPidFile: boolean;
  pid?: number;
  portProcesses: PortProcess[];
  ports: number[];
  hasDockerCompose: boolean;
  resources: string[];
  skipped: string[];
};

type PortProcess = {
  pid: number;
  port: number;
};

const decoder = new TextDecoder();
const fallbackLocalDevPorts = [8080, 3000];

export async function buildLocalDevCleanupPlan(options: LocalDevOptions = {}): Promise<LocalDevCleanupPlan> {
  const root = options.root ?? defaultServiceRoot();
  const pidFile = join(root, ".service", "local-dev.pid");
  const hasPidFile = await Bun.file(pidFile).exists();
  const pid = hasPidFile ? parsePid(await Bun.file(pidFile).text()) : undefined;
  const ports = options.ports ?? defaultLocalDevPorts();
  const portProcesses = findServicePortProcesses(root, ports, pid);
  const hasDockerCompose = Boolean(options.dockerCompose) && (await Bun.file(join(root, "docker-compose.yml")).exists());
  const resources: string[] = [];
  const skipped: string[] = [];

  if (hasPidFile) {
    resources.push(`Local dev process from ${pidFile}`);
  } else if (portProcesses.length > 0) {
    resources.push(formatPortProcesses(portProcesses));
  } else {
    skipped.push(`Local dev process: no .service/local-dev.pid or service-owned listener on ${ports.join(", ")}`);
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
    portProcesses,
    ports,
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
      if (isServiceOwnedPid(root, plan.pid)) {
        messages.push(stopPid(plan.pid) ? `Stopped local dev process ${plan.pid}` : `Removed stale local dev pid file for ${plan.pid}`);
      } else if (isRunning(plan.pid)) {
        messages.push(
          `Skipping pid-file process ${plan.pid}; it is not running from ${root}. Inspect with: ps -p ${plan.pid} -o pid=,command=`,
        );
      } else {
        messages.push(`Removed stale local dev pid file for ${plan.pid}`);
      }
    } else {
      messages.push(`Removed invalid local dev pid file ${plan.pidFile}`);
    }
    await rm(plan.pidFile, { force: true });
  } else {
    const stopped = stopPortProcesses(plan.portProcesses);
    messages.push(
      stopped.length > 0
        ? `Stopped ${formatPortProcesses(stopped)}`
        : "No local dev pid file found and no service-owned local dev process was listening",
    );
  }

  if (plan.hasDockerCompose) {
    const result = runDockerComposeDown(root, Boolean(options.removeVolumes));
    messages.push(result);
  }

  assertPortsClean(plan.ports);

  return messages.join("\n");
}

function defaultServiceRoot() {
  return process.env.CREATE_SVC_SERVICE_ROOT?.trim() || process.cwd();
}

function parsePid(raw: string) {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function defaultLocalDevPorts() {
  const configuredPort = Bun.env.PORT?.trim();
  if (configuredPort) {
    const port = Number(configuredPort);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid PORT: ${Bun.env.PORT}`);
    }
    return [port];
  }
  return fallbackLocalDevPorts;
}

function isServiceOwnedPid(root: string, pid: number) {
  const cwd = processCwd(pid);
  if (!cwd) {
    return false;
  }
  return isPathInside(root, cwd);
}


function stopPid(pid: number) {
  const wasRunning = isRunning(pid);
  if (!wasRunning) {
    return false;
  }
  tryKill(-pid, "SIGTERM") || tryKill(pid, "SIGTERM");
  waitForExit(pid, 1_000);
  if (isRunning(pid)) {
    tryKill(-pid, "SIGKILL") || tryKill(pid, "SIGKILL");
    waitForExit(pid, 1_000);
  }
  return !isRunning(pid);
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

function waitForExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      return;
    }
    Bun.sleepSync(50);
  }
}

function findServicePortProcesses(root: string, ports: number[], pidFromFile?: number): PortProcess[] {
  const seen = new Set<string>();
  const processes: PortProcess[] = [];
  for (const port of ports) {
    for (const pid of listeningPids(port)) {
      if (pid === pidFromFile) {
        continue;
      }
      const key = `${pid}:${port}`;
      if (seen.has(key)) {
        continue;
      }
      const cwd = processCwd(pid);
      if (cwd && isPathInside(root, cwd)) {
        processes.push({ pid, port });
        seen.add(key);
      }
    }
  }
  return processes;
}

function isPathInside(root: string, path: string) {
  const resolvedRoot = realpath(root);
  const resolvedPath = realpath(path);
  const rootWithSlash = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootWithSlash);
}

function realpath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function listeningPids(port: number) {
  const pids = new Set<number>();
  for (const pid of listeningPidsFromLsof(port)) {
    pids.add(pid);
  }
  for (const pid of listeningPidsFromFuser(port)) {
    pids.add(pid);
  }
  return [...pids];
}

function listeningPidsFromLsof(port: number) {
  if (!Bun.which("lsof")) {
    return [];
  }

  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success || !result.stdout) {
    return [];
  }
  return decoder
    .decode(result.stdout)
    .split("\n")
    .map((line) => (line.startsWith("p") ? Number.parseInt(line.slice(1), 10) : undefined))
    .filter((pid): pid is number => Boolean(pid && Number.isFinite(pid)));
}

function listeningPidsFromFuser(port: number) {
  if (process.platform !== "linux" || !Bun.which("fuser")) {
    return [];
  }

  const result = Bun.spawnSync(["fuser", "-n", "tcp", String(port)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    return [];
  }
  return decoder
    .decode(result.stdout)
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid): pid is number => Boolean(pid && Number.isFinite(pid)));
}

function processCwd(pid: number) {
  if (process.platform === "linux") {
    const procCwd = realpath(`/proc/${pid}/cwd`);
    if (procCwd !== `/proc/${pid}/cwd`) {
      return procCwd;
    }
  }

  const result = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success || !result.stdout) {
    return undefined;
  }
  return decoder
    .decode(result.stdout)
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

function stopPortProcesses(processes: PortProcess[]) {
  const stopped: PortProcess[] = [];
  for (const portProcess of processes) {
    if (stopPid(portProcess.pid) || !listeningPids(portProcess.port).includes(portProcess.pid)) {
      stopped.push(portProcess);
    }
  }
  return stopped;
}

function formatPortProcesses(processes: PortProcess[]) {
  return processes
    .map((portProcess) => `local dev process ${portProcess.pid} on port ${portProcess.port}`)
    .join(", ");
}

function assertPortsClean(ports: number[]) {
  for (const port of ports) {
    const pids = listeningPids(port).sort((a, b) => a - b);
    if (pids.length === 0) {
      continue;
    }
    throw new Error(
      [
        `Port ${port} is still listening after dev down: ${pids.join(", ")}`,
        `Inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
        `Stop manually with: kill ${pids.join(" ")}`,
      ].join("\n"),
    );
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
