import { expect, test } from "bun:test";
import { resolveTemporalRuntimeConfigValues } from "./temporal-config";

const baseConfig = {
  enabled: true,
  address: "localhost:7233",
  namespace: "default",
  taskQueue: "orders",
  apiKeySecretName: "orders-temporal-api-key",
  tlsCaCertSecretName: "orders-temporal-ca-cert",
  tlsCertSecretName: "orders-temporal-client-cert",
  tlsKeySecretName: "orders-temporal-client-key",
  vaultMount: "secret",
  vaultPath: "prod/providers/temporal",
};

test("resolveTemporalRuntimeConfigValues reads production Temporal config from Vault fields", () => {
  const resolved = resolveTemporalRuntimeConfigValues(baseConfig, {}, () => ({
    address: "temporal.example.tmprl.cloud:7233",
    namespace: "anmho.prod",
    apiKey: "secret-key",
  }));

  expect(resolved).toEqual({
    enabled: true,
    address: "temporal.example.tmprl.cloud:7233",
    namespace: "anmho.prod",
    taskQueue: "orders",
    apiKeySecretName: "orders-temporal-api-key",
    apiKey: "secret-key",
    tlsCaCertSecretName: "",
    tlsCertSecretName: "",
    tlsKeySecretName: "",
    tlsCaCert: "",
    tlsCert: "",
    tlsKey: "",
  });
});

test("resolveTemporalRuntimeConfigValues reads self-hosted mTLS config from Vault fields", () => {
  const resolved = resolveTemporalRuntimeConfigValues(baseConfig, {}, () => ({
    address: "temporal-grpc.anmho.com:7233",
    namespace: "default",
    tlsCaCert: "ca-pem",
    tlsCert: "cert-pem",
    tlsKey: "key-pem",
  }));

  expect(resolved).toMatchObject({
    enabled: true,
    address: "temporal-grpc.anmho.com:7233",
    namespace: "default",
    taskQueue: "orders",
    apiKey: "",
    apiKeySecretName: "",
    tlsCaCertSecretName: "orders-temporal-ca-cert",
    tlsCertSecretName: "orders-temporal-client-cert",
    tlsKeySecretName: "orders-temporal-client-key",
    tlsCaCert: "ca-pem",
    tlsCert: "cert-pem",
    tlsKey: "key-pem",
  });
});

test("resolveTemporalRuntimeConfigValues renders configured mTLS secret names without raw credentials", () => {
  const resolved = resolveTemporalRuntimeConfigValues(
    { ...baseConfig, address: "temporal-grpc.anmho.com:7233" },
    {},
    () => ({
      namespace: "default",
    })
  );

  expect(resolved).toMatchObject({
    enabled: true,
    address: "temporal-grpc.anmho.com:7233",
    namespace: "default",
    tlsCaCertSecretName: "orders-temporal-ca-cert",
    tlsCertSecretName: "orders-temporal-client-cert",
    tlsKeySecretName: "orders-temporal-client-key",
    tlsCaCert: "",
    tlsCert: "",
    tlsKey: "",
  });
});

test("resolveTemporalRuntimeConfigValues prefers explicit environment overrides", () => {
  const resolved = resolveTemporalRuntimeConfigValues(
    baseConfig,
    {
      TEMPORAL_ADDRESS: "env.temporal:7233",
      TEMPORAL_NAMESPACE: "env.namespace",
      TEMPORAL_TASK_QUEUE: "env-task-queue",
      TEMPORAL_API_KEY: "env-key",
      TEMPORAL_API_KEY_SECRET: "env-secret-name",
    },
    () => ({
      address: "vault.temporal:7233",
      namespace: "vault.namespace",
      apiKey: "vault-key",
    })
  );

  expect(resolved.address).toBe("env.temporal:7233");
  expect(resolved.namespace).toBe("env.namespace");
  expect(resolved.taskQueue).toBe("env-task-queue");
  expect(resolved.apiKey).toBe("env-key");
  expect(resolved.apiKeySecretName).toBe("env-secret-name");
});

test("resolveTemporalRuntimeConfigValues rejects partial mTLS config", () => {
  expect(() =>
    resolveTemporalRuntimeConfigValues({ ...baseConfig, address: "temporal-grpc.anmho.com:7233" }, {}, () => ({
      namespace: "default",
      tlsCaCert: "ca-pem",
    }))
  ).toThrow("Temporal mTLS is partially configured");
});

test("resolveTemporalRuntimeConfigValues fails clearly when enabled Temporal resolves to localhost", () => {
  expect(() => resolveTemporalRuntimeConfigValues(baseConfig, {}, () => ({}))).toThrow(
    "Temporal is enabled for this Cloud Run service, but the resolved Temporal address is local"
  );
});

test("resolveTemporalRuntimeConfigValues allows explicit Temporal disable", () => {
  const resolved = resolveTemporalRuntimeConfigValues(baseConfig, { TEMPORAL_ENABLED: "false" }, () => ({}));

  expect(resolved.enabled).toBeFalse();
  expect(resolved.apiKeySecretName).toBe("");
  expect(resolved.tlsCaCertSecretName).toBe("");
});
