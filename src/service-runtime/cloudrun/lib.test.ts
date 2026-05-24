import { afterEach, expect, test } from "bun:test";
import { parseDeployArgs } from "./deploy-args";

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
