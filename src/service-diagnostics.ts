import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type FindServiceBinariesOptions = {
  pathEnv?: string;
  commandName?: string;
  isExecutable?: (path: string) => boolean;
};

type BuildServiceDoctorReportOptions = {
  activeBinaryPath: string;
  packageRoot: string;
  packageVersion: string;
  latestVersion?: string;
  latestVersionError?: string;
  serviceBinaries: string[];
  getBinaryVersion: (path: string) => string | undefined;
};

type DoctorReport = {
  exitCode: number;
  text: string;
};

const PACKAGE_NAME = "create-svc";
const SERVICE_COMMAND = "service";

export function packageRootFromModuleUrl(moduleUrl: string) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

export function readPackageVersion(packageRoot: string) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  return packageJson.version ?? "unknown";
}

export function findServiceBinaries(options: FindServiceBinariesOptions = {}) {
  const commandName = options.commandName ?? SERVICE_COMMAND;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const seen = new Set<string>();
  const results: string[] = [];

  for (const entry of (options.pathEnv ?? process.env.PATH ?? "").split(":")) {
    if (!entry) {
      continue;
    }

    const candidate = join(entry, commandName);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (isExecutable(candidate)) {
      results.push(candidate);
    }
  }

  return results;
}

export function buildServiceDoctorReport(options: BuildServiceDoctorReportOptions): DoctorReport {
  const lines = [
    "service doctor",
    `active binary: ${options.activeBinaryPath}`,
    `package root: ${options.packageRoot}`,
    `package version: ${options.packageVersion}`,
  ];

  if (options.latestVersion) {
    lines.push(`npm latest: ${options.latestVersion}`);
  } else if (options.latestVersionError) {
    lines.push(`npm latest: unavailable (${options.latestVersionError})`);
  } else {
    lines.push("npm latest: unavailable");
  }

  const binaries = uniquePaths(options.serviceBinaries);
  const binaryDiagnostics = binaries.map((path) => {
    const version = options.getBinaryVersion(path);
    const stale = Boolean(version && options.latestVersion && compareVersions(version, options.latestVersion) < 0);
    return { path, version, stale };
  });

  const staleBinaries = binaryDiagnostics.filter((binary) => binary.stale);
  if (binaryDiagnostics.length > 1) {
    lines.push("");
    lines.push("warning: multiple service binaries found on PATH");
    for (const binary of binaryDiagnostics) {
      const version = binary.version ?? "unknown";
      const state = binary.stale ? "stale" : binary.version && options.latestVersion ? "current" : "unknown";
      lines.push(`- ${binary.path}`);
      lines.push(`  version: ${version} (${state})`);
      if (binary.stale) {
        lines.push(`  cleanup: rm "${binary.path}"`);
        lines.push(`  update: npm install -g ${PACKAGE_NAME}@latest`);
      }
    }
  }

  return {
    exitCode: staleBinaries.length > 0 ? 1 : 0,
    text: lines.join("\n"),
  };
}

export function getInstalledServiceVersion(binaryPath: string) {
  const result = safeSpawn([binaryPath, "--version"]);

  if (!result || !result.success || !result.stdout) {
    return undefined;
  }

  return new TextDecoder().decode(result.stdout).trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

export function getNpmLatestVersion() {
  const result = safeSpawn(["npm", "view", `${PACKAGE_NAME}@latest`, "version"]);

  if (!result || !result.success || !result.stdout) {
    const stderr = result?.stderr ? new TextDecoder().decode(result.stderr).trim() : "npm view failed";
    return { error: stderr || "npm view failed" };
  }

  return { version: new TextDecoder().decode(result.stdout).trim() };
}

function safeSpawn(command: string[]) {
  try {
    return Bun.spawnSync(command, {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return undefined;
  }
}

export function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let i = 0; i < 3; i += 1) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function parseVersion(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.split(/[.-]/, 3);
  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths)];
}

function defaultIsExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
