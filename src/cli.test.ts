import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import {
  assertDiscoveryReady,
  buildClerkVaultFields,
  normalizeValidationResult,
  parseArgs,
  resolveClerkVaultFields,
  validateProfileRuntimeFramework,
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

test("parseArgs accepts the app profile", () => {
  expect(parseArgs(["tracker", "--profile=app", "--yes"])).toMatchObject({
    directory: "tracker",
    profile: "app",
    yes: true,
  });
  expect(parseArgs(["tracker", "--profile", "app", "--yes"])).toMatchObject({
    directory: "tracker",
    profile: "app",
    yes: true,
  });
});

test("parseArgs accepts Clerk Vault key flags", () => {
  expect(
    parseArgs([
      "tracker",
      "--profile=app",
      "--yes",
      "--clerk-publishable-key=pk_live_example",
      "--clerk-secret-key",
      "sk_live_example",
      "--clerk-webhook-secret=whsec_example",
    ])
  ).toMatchObject({
    profile: "app",
    clerkPublishableKey: "pk_live_example",
    clerkSecretKey: "sk_live_example",
    clerkWebhookSecret: "whsec_example",
  });
});

test("buildClerkVaultFields trims and maps app keys to the expected Vault fields", () => {
  expect(
    buildClerkVaultFields({
      publishableKey: " pk_live_example ",
      secretKey: " sk_live_example ",
      webhookSecret: " whsec_example ",
    })
  ).toEqual({
    publishable_key: "pk_live_example",
    secret_key: "sk_live_example",
    webhook_secret: "whsec_example",
  });
});

test("resolveClerkVaultFields checks Vault before prompting in the interactive app TUI", async () => {
  let prompted = false;

  const result = await resolveClerkVaultFields(parseArgs(["tracker", "--profile=app"]), "app", {
    readExistingFields: async () => ({
      publishable_key: "pk_live_example",
      secret_key: "sk_live_example",
      webhook_secret: "whsec_example",
    }),
    confirmWrite: async () => {
      prompted = true;
      return true;
    },
    promptPublishableKey: async () => "pk_live_prompted",
    promptSecretKey: async () => "sk_live_prompted",
    promptWebhookSecret: async () => "whsec_prompted",
  });

  expect(result).toEqual({ action: "present" });
  expect(prompted).toBe(false);
});

test("app profile requires the Bun ConnectRPC backend", () => {
  expect(() => validateProfileRuntimeFramework("app", "go", "connectrpc")).toThrow(
    "The app profile currently supports only bun + connectrpc"
  );
  expect(() => validateProfileRuntimeFramework("app", "bun", "hono")).toThrow(
    "The app profile currently supports only bun + connectrpc"
  );
  expect(() => validateProfileRuntimeFramework("app", "bun", "connectrpc")).not.toThrow();
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
