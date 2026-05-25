export type DeployArgs = {
  build: "local" | "cloudbuild";
  ci: boolean;
  destroy: boolean;
  environment: "main" | "preview" | "personal";
  name?: string;
};

export type RuntimeMigrationCommand = {
  command: string;
  args: string[];
};

export const CLOUD_RUN_LOCAL_BUILD_PLATFORM = "linux/amd64";

export function localDockerBuildArgs(image: string) {
  return ["build", "--platform", CLOUD_RUN_LOCAL_BUILD_PLATFORM, "-t", image, "."];
}

export function parseDeployArgs(argv: string[]): DeployArgs {
  const parsed: DeployArgs = {
    build: parseBuildStrategy(process.env.SERVICE_BUILD_STRATEGY || process.env.SERVICE_BUILD),
    ci: false,
    destroy: false,
    environment: "main",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) {
      continue;
    }

    const next = argv[i + 1];
    const readValue = () => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return next;
    };

    if (token === "--ci") {
      parsed.ci = true;
      continue;
    }

    if (token === "--destroy") {
      parsed.destroy = true;
      continue;
    }

    if (token === "--build") {
      parsed.build = parseBuildStrategy(readValue());
      continue;
    }

    if (token.startsWith("--build=")) {
      parsed.build = parseBuildStrategy(token.slice("--build=".length));
      continue;
    }

    if (token === "--cloud-build") {
      parsed.build = "cloudbuild";
      continue;
    }

    if (token === "--environment") {
      parsed.environment = readValue() as DeployArgs["environment"];
      continue;
    }

    if (token.startsWith("--environment=")) {
      parsed.environment = token.slice("--environment=".length) as DeployArgs["environment"];
      continue;
    }

    if (token === "--name") {
      parsed.name = readValue();
      continue;
    }

    if (token.startsWith("--name=")) {
      parsed.name = token.slice("--name=".length);
      continue;
    }
  }

  return parsed;
}

function parseBuildStrategy(value: string | undefined): DeployArgs["build"] {
  if (!value || value === "local") {
    return "local";
  }
  if (value === "cloudbuild" || value === "cloud-build") {
    return "cloudbuild";
  }
  throw new Error(`Unknown build strategy: ${value}`);
}

export function migrationCommandForRuntime(runtime: string): RuntimeMigrationCommand {
  if (runtime === "bun") {
    return { command: "bun", args: ["run", "./scripts/migrate.ts"] };
  }

  if (runtime === "go") {
    return { command: "atlas", args: ["migrate", "apply", "--env", "local"] };
  }

  throw new Error(`migrate is not available for ${runtime}`);
}
