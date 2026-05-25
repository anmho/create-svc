import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import {
  assertDiscoveryReady,
  formatScaffoldHelp,
  normalizeValidationResult,
  parseArgs,
  resolveAutoDeploy,
  validateTargetRuntimeFramework,
  validateServiceNameInput,
} from "./cli";

test("normalizeValidationResult converts success to undefined", () => {
  expect(normalizeValidationResult(true)).toBeUndefined();
});

test("normalizeValidationResult preserves validation errors", () => {
  expect(normalizeValidationResult("Service name is required")).toBe("Service name is required");
});

test("assertDiscoveryReady no longer blocks scaffold when remote discovery is unavailable", () => {
  expect(
    assertDiscoveryReady({
      projects: [],
      billingAccounts: [],
      warnings: ["Skipping GCP project discovery: gcloud not installed"],
    })
  ).toEqual({
    projects: [],
    billingAccounts: [],
    warnings: ["Skipping GCP project discovery: gcloud not installed"],
  });
});

test("parseArgs defaults to microservice and cloudrun target", () => {
  expect(parseArgs(["launch-api", "--yes"])).toMatchObject({
    serviceName: "launch-api",
    profile: "microservice",
    yes: true,
  });
  expect(parseArgs(["launch-api", "--target", "workers", "--yes"])).toMatchObject({
    serviceName: "launch-api",
    target: "workers",
    yes: true,
  });
  expect(parseArgs(["launch-api", "--yes"]).autoDeploy).toBeUndefined();
  expect(parseArgs(["launch-api", "--yes", "--no-git"]).noGit).toBeTrue();

  expect(() => parseArgs(["launch-api", "--profile", "microservice", "--bootstrap"])).toThrow("Unknown argument");
});

test("resolveAutoDeploy defaults to one-shot create and deploy", () => {
  expect(resolveAutoDeploy(undefined)).toBeTrue();
  expect(resolveAutoDeploy(true)).toBeTrue();
  expect(resolveAutoDeploy(false)).toBeFalse();
});

test("parseArgs supports an explicit output directory", () => {
  expect(parseArgs(["launch-api", "--dir", "/tmp/generated-launch-api", "--yes"])).toMatchObject({
    serviceName: "launch-api",
    directory: "/tmp/generated-launch-api",
    yes: true,
  });
  expect(parseArgs(["--dir=/tmp/generated-launch-api", "--yes"])).toMatchObject({
    directory: "/tmp/generated-launch-api",
    yes: true,
  });
});

test("formatScaffoldHelp is compact and starts at usage", () => {
  const help = formatScaffoldHelp();
  expect(help.startsWith("Usage:\n")).toBeTrue();
  expect(help).not.toContain("\n\n\n");
  expect(help).not.toContain("│");
  expect(help).toContain("service new <service_id> [options]");
  expect(help).toContain("service create <service_id> [options]");
  expect(help).toContain("--dir <path>");
});

test("parseArgs rejects the removed app profile", () => {
  expect(() => parseArgs(["tracker", "--profile=app", "--yes"])).toThrow("app profile has moved");
});

test("target/runtime/framework combinations are validated", () => {
  expect(() => validateTargetRuntimeFramework("cloudrun", "go", "connectrpc")).not.toThrow();
  expect(() => validateTargetRuntimeFramework("workers", "bun", "hono")).not.toThrow();
  expect(() => validateTargetRuntimeFramework("workers", "bun", "connectrpc")).toThrow(
    "Framework connectrpc is not valid for target workers and runtime bun"
  );
  expect(() => validateTargetRuntimeFramework("workers", "go", "connectrpc")).toThrow(
    "Framework connectrpc is not valid for target workers and runtime go"
  );
});

test("validateServiceNameInput rejects a taken target directory", async () => {
  const cwd = process.cwd();
  const root = "/tmp/create-svc-cli-validation";
  await mkdir(root, { recursive: true });
  await mkdir(`${root}/taken-app`, { recursive: true });
  await Bun.write(`${root}/taken-app/keep.txt`, "x");

  process.chdir(root);
  try {
    expect(validateServiceNameInput("taken-app")).toBe("Directory already exists and is not empty");
  } finally {
    process.chdir(cwd);
  }
});
