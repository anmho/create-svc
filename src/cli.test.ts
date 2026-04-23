import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { assertDiscoveryReady, normalizeValidationResult, validateServiceNameInput } from "./cli";

test("normalizeValidationResult converts success to undefined", () => {
  expect(normalizeValidationResult(true)).toBeUndefined();
});

test("normalizeValidationResult preserves validation errors", () => {
  expect(normalizeValidationResult("Service name is required")).toBe("Service name is required");
});

test("assertDiscoveryReady requires Neon discovery to succeed", () => {
  expect(() =>
    assertDiscoveryReady({
      projects: [],
      billingAccounts: [],
      warnings: [],
      neonError: "Vault secret resolution requires VAULT_ADDR, VAULT_TOKEN, and a secret path",
    })
  ).toThrow(
    "Neon discovery is required before scaffolding. Set NEON_API_KEY, or use Vault by providing VAULT_ADDR and either VAULT_TOKEN, VAULT_TOKEN_FILE, or ~/.vault-token. Optional overrides: VAULT_SECRET_MOUNT, VAULT_NEON_API_KEY_PATH, VAULT_NEON_API_KEY_FIELD."
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
