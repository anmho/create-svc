import { mkdir } from "node:fs/promises";
import { join } from "node:path";

type StartedProcess = {
  name: string;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
};

const root = process.cwd();
const children: StartedProcess[] = [];

async function main() {
  await mkdir(join(root, "tmp"), { recursive: true });

  await run("install dependencies", ["bun", "install"]);
  await run("start local postgres", ["docker", "compose", "up", "-d"]);
  await run("generate shared ConnectRPC client", ["bun", "run", "gen"]);
  await run("run API migrations", ["bun", "run", "migrate"]);

  children.push(start("api", ["bun", "run", "dev"], { cwd: join(root, "apps", "api") }));
  await waitForHttp("http://127.0.0.1:8080/healthz", "api");

  children.push(start("web", ["bun", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3000"], { cwd: join(root, "apps", "web") }));
  await waitForHttp("http://127.0.0.1:3000", "web");

  await bootIosSimulator();
  children.push(
    start(
      "mobile",
      ["bunx", "expo", "start", "--ios", "--go", "--port", "8081"],
      {
        cwd: join(root, "apps", "mobile"),
        env: { EXPO_PUBLIC_API_URL: Bun.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080" },
      }
    )
  );

  console.log("go-button ready");
  console.log("- API: http://127.0.0.1:8080");
  console.log("- Web: http://127.0.0.1:3000");
  console.log("- Mobile: Expo Go on the booted iOS Simulator");

  await Promise.race(children.map((child) => child.proc.exited));
}

async function run(name: string, command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  console.log(`-> ${name}`);
  const proc = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${name} failed with exit code ${exitCode}`);
  }
}

function start(name: string, command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  console.log(`-> start ${name}`);
  const proc = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  streamOutput(name, proc.stdout);
  streamOutput(name, proc.stderr);
  return { name, proc };
}

async function streamOutput(name: string, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return;
    }
    process.stdout.write(prefixLines(name, decoder.decode(result.value)));
  }
}

function prefixLines(name: string, input: string) {
  return input
    .split(/(\n)/)
    .map((part) => (part === "\n" || part.length === 0 ? part : `[${name}] ${part}`))
    .join("");
}

async function waitForHttp(url: string, name: string) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`${name} did not become ready at ${url}: ${lastError}`);
}

async function bootIosSimulator() {
  const booted = await runCapture(["xcrun", "simctl", "list", "devices", "booted"]);
  if (booted.includes("iPhone")) {
    await run("open Simulator", ["open", "-a", "Simulator"]);
    return;
  }

  const devices = JSON.parse(await runCapture(["xcrun", "simctl", "list", "devices", "available", "-j"]));
  const runtimes = Object.values(devices.devices ?? {}) as Array<Array<{ name: string; udid: string; isAvailable: boolean }>>;
  const iphone = runtimes.flat().find((device) => device.isAvailable && device.name.includes("iPhone"));
  if (!iphone) {
    throw new Error("No available iPhone simulator was found");
  }

  await run("boot iOS Simulator", ["xcrun", "simctl", "boot", iphone.udid]).catch(() => {});
  await run("open Simulator", ["open", "-a", "Simulator"]);
}

async function runCapture(command: string[]) {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}

function shutdown() {
  for (const child of children) {
    child.proc.kill();
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

main()
  .catch((error) => {
    shutdown();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
