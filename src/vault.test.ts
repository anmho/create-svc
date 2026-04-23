import { afterEach, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { readVaultSecret, resolveNeonApiKey } from "./vault";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  mock.restore();
});

test("resolveNeonApiKey prefers NEON_API_KEY from env", async () => {
  process.env.NEON_API_KEY = "direct-token";
  await expect(resolveNeonApiKey()).resolves.toBe("direct-token");
});

test("readVaultSecret reads KV v2 secret data using existing vault login env", async () => {
  process.env.VAULT_ADDR = "https://vault.example.com";
  process.env.VAULT_TOKEN = "token-123";

  const fetchMock = mock(async (input: string | URL | Request) => {
    expect(String(input)).toBe("https://vault.example.com/v1/secret/data/provider/neon-api-key");
    return new Response(
      JSON.stringify({
        data: {
          data: {
            value: "vault-token",
          },
        },
      }),
      { status: 200 }
    );
  });

  globalThis.fetch = fetchMock as typeof fetch;

  await expect(
    readVaultSecret({
      path: "provider/neon-api-key",
      field: "value",
    })
  ).resolves.toBe("vault-token");
});

test("readVaultSecret falls back to ~/.vault-token", async () => {
  const home = "/tmp/create-svc-vault-home";
  process.env.HOME = home;
  process.env.VAULT_ADDR = "https://vault.example.com";
  delete process.env.VAULT_TOKEN;

  await mkdir(home, { recursive: true });
  await Bun.write(`${home}/.vault-token`, "token-from-file\n");

  const fetchMock = mock(async () => {
    return new Response(
      JSON.stringify({
        data: {
          data: {
            value: "vault-token",
          },
        },
      }),
      { status: 200 }
    );
  });

  globalThis.fetch = fetchMock as typeof fetch;

  await expect(
    readVaultSecret({
      path: "provider/neon-api-key",
      field: "value",
    })
  ).resolves.toBe("vault-token");
});
