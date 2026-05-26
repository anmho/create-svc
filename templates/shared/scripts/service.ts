#!/usr/bin/env bun

import { mkdir, readFile, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ProcessInfo = {
  pid: number;
  command: string;
  cwd?: string;
};

const decoder = new TextDecoder();
const serviceStateDir = ".service";
const localDevPidFile = `${serviceStateDir}/local-dev.pid`;

async function main(argv = Bun.argv.slice(2)) {
  const [scope, action] = argv;

  if (scope === "dev" && action === "down") {
    await devDown();
    return;
  }

  throw new Error("Usage: service dev down");
}

export async function devDown() {
  const serviceRoot = resolve(process.cwd());
  const port = Number(Bun.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${Bun.env.PORT}`);
  }

  await mkdir(serviceStateDir, { recursive: true });

  const stoppedPids = new Set<number>();
  const pidFilePid = await readPidFile();
  if (pidFilePid !== undefined) {
    const info = await getProcessInfo(pidFilePid);
    if (info && isServiceProcess(info, serviceRoot)) {
      await stopProcess(info, "pid file");
      stoppedPids.add(info.pid);
    } else if (info) {
      console.warn(
        `Skipping pid-file process ${pidFilePid}; it is not running from ${serviceRoot}. Inspect with: ps -p ${pidFilePid} -o pid=,command=`
      );
    }
  } else {
    console.warn(`No local dev pid file found at ${localDevPidFile}`);
  }

  const listeners = await getPortListeners(port);
  for (const listener of listeners) {
    if (stoppedPids.has(listener.pid)) {
      continue;
    }
    if (!isServiceProcess(listener, serviceRoot)) {
      continue;
    }
    await stopProcess(listener, `port ${port}`);
    stoppedPids.add(listener.pid);
  }

  await removePidFile();
  await dockerComposeDown();
  await assertPortIsClean(port);

  const stopped = [...stoppedPids].sort((a, b) => a - b);
  console.log(stopped.length > 0 ? `Stopped local dev process(es): ${stopped.join(", ")}` : "No local dev process was running");
}

async function readPidFile() {
  try {
    const raw = (await readFile(localDevPidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removePidFile() {
  await rm(localDevPidFile, { force: true });
}

async function stopProcess(info: ProcessInfo, source: string) {
  try {
    process.kill(info.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return;
  }

  const stopped = await waitForProcessExit(info.pid, 2_000);
  if (!stopped) {
    process.kill(info.pid, "SIGKILL");
    await waitForProcessExit(info.pid, 2_000);
  }

  console.log(`Stopped ${source} process ${info.pid}: ${info.command}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await isProcessRunning(pid))) {
      return true;
    }
    await Bun.sleep(100);
  }
  return !(await isProcessRunning(pid));
}

async function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function getPortListeners(port: number): Promise<ProcessInfo[]> {
  if (!Bun.which("lsof")) {
    throw new Error(`Missing required command: lsof. Inspect manually with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  }

  const result = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { allowFailure: true });
  const pids = new Set(
    result.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  );

  const infos: ProcessInfo[] = [];
  for (const pid of pids) {
    const info = await getProcessInfo(pid);
    if (info) {
      infos.push(info);
    }
  }
  return infos;
}

async function getProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  const ps = run("ps", ["-p", String(pid), "-o", "command="], { allowFailure: true });
  if (!ps.success || !ps.stdout.trim()) {
    return undefined;
  }

  const cwd = readProcessCwd(pid);
  return {
    pid,
    command: ps.stdout.trim(),
    cwd,
  };
}

function readProcessCwd(pid: number) {
  if (!Bun.which("lsof")) {
    return undefined;
  }

  const result = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { allowFailure: true });
  if (!result.success) {
    return undefined;
  }

  return result.stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

function isServiceProcess(info: ProcessInfo, serviceRoot: string) {
  if (!info.cwd) {
    return false;
  }

  const processCwd = resolve(info.cwd);
  const path = relative(serviceRoot, processCwd);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

async function dockerComposeDown() {
  if (!(await Bun.file("docker-compose.yml").exists())) {
    return;
  }
  if (!Bun.which("docker")) {
    console.warn("Skipping Docker Compose cleanup because docker is not installed");
    return;
  }

  const result = run("docker", ["compose", "down"], { allowFailure: true });
  if (!result.success) {
    console.warn(`Docker Compose cleanup failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
}

async function assertPortIsClean(port: number) {
  const remaining = await getPortListeners(port);
  if (remaining.length === 0) {
    return;
  }

  const pids = remaining.map((info) => info.pid).sort((a, b) => a - b);
  throw new Error(
    [
      `Port ${port} is still listening after dev down: ${pids.join(", ")}`,
      `Inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      `Stop manually with: kill ${pids.join(" ")}`,
    ].join("\n")
  );
}

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const commandResult = {
    success: result.success,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : "",
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : "",
    exitCode: result.exitCode,
  };

  if (!commandResult.success && !options.allowFailure) {
    throw new Error(`command failed: ${command} ${args.join(" ")}\n${commandResult.stderr || commandResult.stdout}`);
  }

  return commandResult;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
