import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { assertDiscoveryReady, normalizeValidationResult, parseArgs, validateServiceNameInput } from "./cli";

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

test("parseArgs defaults to the microservice profile and treats bootstrap as strict deploy", () => {
  expect(parseArgs(["launch-api", "--yes"])).toMatchObject({
    directory: "launch-api",
    profile: "microservice",
    yes: true,
  });
  expect(parseArgs(["launch-api", "--yes"]).autoDeploy).toBeUndefined();

  expect(parseArgs(["launch-api", "--profile", "microservice", "--bootstrap"])).toMatchObject({
    directory: "launch-api",
    profile: "microservice",
    autoDeploy: true,
  });
});

test("parseArgs rejects the moved app profile with private template guidance", () => {
  expect(() => parseArgs(["tracker", "--profile=app", "--yes"])).toThrow("anmho/create-app-consumer");
  expect(() => parseArgs(["tracker", "--profile", "app", "--yes"])).toThrow("anmho/create-app-saas");
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
