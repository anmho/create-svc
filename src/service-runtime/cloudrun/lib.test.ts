import { afterEach, expect, test } from "bun:test";
import { cloudRunServiceNamesForDestroy, localDockerBuildArgs, migrationCommandForRuntime, parseDeployArgs } from "./deploy-args";

const originalBuild = process.env.SERVICE_BUILD;
const originalBuildStrategy = process.env.SERVICE_BUILD_STRATEGY;

afterEach(() => {
  process.env.SERVICE_BUILD = originalBuild;
  process.env.SERVICE_BUILD_STRATEGY = originalBuildStrategy;
});

test("parseDeployArgs defaults to local image builds", () => {
  delete process.env.SERVICE_BUILD;
  delete process.env.SERVICE_BUILD_STRATEGY;

  expect(parseDeployArgs([]).build).toBe("local");
});

test("parseDeployArgs accepts explicit Cloud Build fallback", () => {
  expect(parseDeployArgs(["--build", "cloudbuild"]).build).toBe("cloudbuild");
  expect(parseDeployArgs(["--build=cloud-build"]).build).toBe("cloudbuild");
  expect(parseDeployArgs(["--cloud-build"]).build).toBe("cloudbuild");
});

test("parseDeployArgs accepts build strategy from env", () => {
  process.env.SERVICE_BUILD_STRATEGY = "cloudbuild";

  expect(parseDeployArgs([]).build).toBe("cloudbuild");
});

test("local Docker builds target Cloud Run's runtime platform", () => {
  expect(localDockerBuildArgs("us-west1-docker.pkg.dev/example/services/api:latest")).toEqual([
    "build",
    "--platform",
    "linux/amd64",
    "-t",
    "us-west1-docker.pkg.dev/example/services/api:latest",
    ".",
  ]);
});

test("migrationCommandForRuntime uses generated migration tooling", () => {
  expect(migrationCommandForRuntime("bun")).toEqual({
    command: "bun",
    args: ["run", "./scripts/migrate.ts"],
  });
  expect(migrationCommandForRuntime("go")).toEqual({
    command: "atlas",
    args: ["migrate", "apply", "--env", "local"],
  });
});

test("cloudRunServiceNamesForDestroy includes api and worker services", () => {
  expect(cloudRunServiceNamesForDestroy("omnichannel-pr-6")).toEqual(["omnichannel-pr-6", "omnichannel-pr-6-worker"]);
});
