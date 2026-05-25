import { mkdir, readdir } from "node:fs/promises";
import { serviceConfig } from "./runtime";
import { formatSdkModeDetail, type SdkState } from "./connect-sdk-state";

type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type PublishedSdk = {
  commit: string;
  digest?: string;
  createTime?: string;
};

type DoctorRecorder = (
  name: string,
  failureStatus: "warn" | "fail",
  check: () => string | Promise<string>
) => Promise<void>;

const decoder = new TextDecoder();

export async function runConnectSdk(args: string[]) {
  if ((serviceConfig.framework as string) !== "connectrpc") {
    throw new Error("SDK commands are only available for ConnectRPC services");
  }

  const [subcommand] = args;
  if (subcommand === "publish") {
    requireCommand("buf");
    const authEnv = resolveBufAuthEnv();
    ensureBufModule(authEnv);
    run("buf", ["push"], { env: authEnv });
    const published = resolvePublishedSdk(authEnv);
    await writeSdkMode("remote", published);
    return `Schema pushed to Buf Schema Registry and recorded for consumers: ${published.commit}`;
  }

  if (subcommand === "build") {
    if (serviceConfig.runtime === "bun") {
      run("bun", ["run", "gen"]);
    } else {
      run("make", ["gen"]);
    }
    await writeSdkMode("local");
    return "Local SDK artifacts generated and recorded";
  }

  if (subcommand === "use-local") {
    await assertLocalSdkArtifacts();
    await writeSdkMode("local");
    return "Local SDK artifacts recorded";
  }

  if (subcommand === "use-remote") {
    requireCommand("buf");
    const authEnv = resolveBufAuthEnv();
    const published = resolvePublishedSdk(authEnv);
    await writeSdkMode("remote", published);
    return `Remote Buf SDK recorded for consumers: ${bufModule()}@${published.commit}`;
  }

  throw new Error("Usage: service sdk <build|publish|use-local|use-remote>");
}

export async function recordConnectSdkDoctorChecks(record: DoctorRecorder) {
  if ((serviceConfig.framework as string) !== "connectrpc") {
    return;
  }

  await record("ConnectRPC proto", "fail", async () => {
    if (!(await Bun.file("./buf.yaml").exists())) {
      throw new Error("missing buf.yaml");
    }
    const protoFiles = await findFiles("./protos", ".proto");
    if (protoFiles.length === 0) {
      throw new Error("missing ConnectRPC proto");
    }
    return `${protoFiles.length} proto file(s) present`;
  });
  await record("Buf CLI", "warn", () => checkCommand("buf"));
  await record("generated SDK artifacts", "warn", async () => {
    const artifacts = await findGeneratedSdkArtifacts();
    if (artifacts.length === 0) {
      throw new Error("generated SDK artifacts are missing; run service sdk build");
    }
    return "local generated artifacts present";
  });
  await record("SDK mode", "warn", async () => {
    const text = await Bun.file(".service/sdk.json").text();
    const state = JSON.parse(text) as SdkState;
    return formatSdkModeDetail(state, bufModule());
  });
  await record("SDK remote publish", "warn", async () => {
    const text = await Bun.file(".service/sdk.json").text();
    const state = JSON.parse(text) as SdkState;
    const module = state.module || bufModule();
    if (state.mode !== "remote") {
      throw new Error(`SDK is in ${state.mode} mode; run service sdk publish to publish ${module}`);
    }
    const authEnv = resolveBufAuthEnv();
    run("buf", ["registry", "module", "info", module], { env: authEnv });
    const published = resolvePublishedSdk(authEnv);
    if (state.remote?.commit && published.commit !== state.remote.commit) {
      return `remote module readable; latest ${published.commit}, recorded ${state.remote.commit}`;
    }
    return `remote module readable at ${module}@${published.commit}`;
  });
}

async function assertLocalSdkArtifacts() {
  const artifacts = await findGeneratedSdkArtifacts();
  if (artifacts.length === 0) {
    throw new Error("Local SDK artifacts are missing. Run `service sdk build` first.");
  }
}

function resolvePublishedSdk(authEnv: Record<string, string> = {}): PublishedSdk {
  const module = bufModule();
  const result = run("buf", ["registry", "module", "commit", "list", module, "--format", "json", "--page-size", "1"], { env: authEnv });
  const parsed = JSON.parse(result.stdout) as {
    commits?: Array<Record<string, unknown>>;
    commit?: Record<string, unknown>;
  };
  const commit = parsed.commits?.[0] ?? parsed.commit;
  if (!commit) {
    throw new Error(`Could not resolve the published Buf commit for ${module}`);
  }
  const name = stringField(commit, "name") ?? stringField(commit, "commit") ?? stringField(commit, "id");
  if (!name) {
    throw new Error(`Buf commit response for ${module} did not include a commit identifier`);
  }
  return {
    commit: name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name,
    digest: stringField(commit, "digest"),
    createTime: stringField(commit, "create_time") ?? stringField(commit, "createTime"),
  };
}

function stringField(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function writeSdkMode(mode: "local" | "remote", published?: PublishedSdk) {
  await mkdir(".service", { recursive: true });
  const localPath = await resolveLocalSdkPath();
  await Bun.write(
    ".service/sdk.json",
    `${JSON.stringify(
      {
        mode,
        module: bufModule(),
        localPath,
        ...(published
          ? {
              remote: {
                commit: published.commit,
                digest: published.digest,
                createTime: published.createTime,
              },
            }
          : {}),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
}

function bufModule() {
  return serviceConfig.buf?.module || `buf.build/anmho-services/${serviceConfig.service_id}`;
}

function ensureBufModule(authEnv: Record<string, string>) {
  const module = bufModule();
  const existing = run("buf", ["registry", "module", "info", module], { env: authEnv, allowFailure: true });
  if (existing.success) {
    return;
  }
  run("buf", ["registry", "module", "create", module, "--visibility", "private"], { env: authEnv });
}

function resolveBufAuthEnv(): Record<string, string> {
  const vault = serviceConfig.providers?.vault ?? {};
  const token =
    process.env.BUF_TOKEN?.trim() ||
    readVaultField(vault.mount || "secret", vault.buf_path || "prod/providers/buf", [
      "BUF_TOKEN",
      "buf.api_token",
      "buf_token",
      "api_token",
      "token",
    ]);
  if (!token) {
    return {};
  }
  return { BUF_TOKEN: token };
}

async function resolveLocalSdkPath() {
  const artifacts = await findGeneratedSdkArtifacts();
  if (artifacts.length === 0) {
    return serviceConfig.runtime === "bun" ? "./gen/protos" : "./gen";
  }
  const artifact = artifacts[0] || "./gen";
  return artifact.split("/").slice(0, -1).join("/") || "./gen";
}

async function findGeneratedSdkArtifacts() {
  const suffixes = serviceConfig.runtime === "bun" ? ["_pb.ts", "_pb.js"] : [".pb.go"];
  const files = await findFiles("./gen");
  return files.filter((file) => suffixes.some((suffix) => file.endsWith(suffix)));
}

async function findFiles(root: string, suffix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await findFiles(path, suffix)));
    } else if (!suffix || path.endsWith(suffix)) {
      files.push(path);
    }
  }
  return files;
}

function requireCommand(name: string) {
  if (!Bun.which(name)) {
    throw new Error(`missing required command: ${name}`);
  }
}

function checkCommand(name: string) {
  const path = Bun.which(name);
  if (!path) {
    throw new Error(`${name} is not installed`);
  }
  return path;
}

function run(command: string, args: string[], options: { allowFailure?: boolean; env?: Record<string, string | undefined> } = {}): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
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
    throw new Error(`command failed: ${command} ${args.join(" ")}`);
  }
  return commandResult;
}

function readVaultField(mount: string, path: string, fields: string[]) {
  const vault = Bun.which("vault");
  if (!vault || !path) {
    return "";
  }

  for (const field of fields) {
    const result = Bun.spawnSync([vault, "kv", "get", `-mount=${mount}`, `-field=${field}`, path], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.success && result.stdout) {
      const value = decoder.decode(result.stdout).trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}
