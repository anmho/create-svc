export async function ensureLocalPostgres() {
  await ensureDockerRunning();
  await run(["docker", "compose", "up", "-d"], { label: "start local postgres" });
}

async function ensureDockerRunning() {
  if (await dockerInfo()) {
    return;
  }

  await openDocker();
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (await dockerInfo()) {
      return;
    }
    await Bun.sleep(2_000);
  }

  throw new Error("Docker did not become ready within 120 seconds. Open Docker Desktop and retry.");
}

async function dockerInfo() {
  const result = await Bun.spawn(["docker", "info"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  return result === 0;
}

async function openDocker() {
  if (process.platform === "darwin") {
    await run(["open", "-a", "Docker"], { label: "open Docker Desktop" });
    return;
  }

  if (process.platform === "win32") {
    await run(["powershell.exe", "-NoProfile", "-Command", "Start-Process 'Docker Desktop'"], {
      label: "open Docker Desktop",
      optional: true,
    });
    return;
  }

  await run(["systemctl", "--user", "start", "docker-desktop"], {
    label: "open Docker Desktop",
    optional: true,
  });
}

async function run(command: string[], options: { label: string; optional?: boolean }) {
  const result = await Bun.spawn(command, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: Bun.env,
  }).exited;

  if (result !== 0 && !options.optional) {
    throw new Error(`${options.label} failed with exit code ${result}`);
  }
}
