import { expect, test } from "bun:test";
import { resolveCloudRunEnv } from "../templates/variants/bun-hono/src/env";
import {
  resolveWorkersProvisioningEnv,
  resolveWorkersRuntimeEnv,
} from "../templates/targets/workers/src/env";

test("generated Cloud Run env validates database auth and Temporal settings", () => {
  expect(
    resolveCloudRunEnv({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app?sslmode=disable",
      AUTH_ENABLED: "true",
      AUTH_ISSUER: "https://auth.example.com/api/auth",
      AUTH_AUDIENCE: "api://waitlist",
      AUTH_JWKS_URL: "https://auth.example.com/api/auth/jwks",
      TEMPORAL_ENABLED: "true",
      TEMPORAL_ADDRESS: "localhost:7233",
      TEMPORAL_NAMESPACE: "default",
      TEMPORAL_TASK_QUEUE: "waitlist",
    })
  ).toMatchObject({
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app?sslmode=disable",
    AUTH_ENABLED: true,
    TEMPORAL_ENABLED: true,
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_NAMESPACE: "default",
  });
});

test("generated Cloud Run env preserves local defaults and fails clearly when required env is missing", () => {
  expect(
    resolveCloudRunEnv({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app?sslmode=disable",
    })
  ).toMatchObject({
    AUTH_ENABLED: false,
    TEMPORAL_ENABLED: true,
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_NAMESPACE: "default",
    TEMPORAL_TASK_QUEUE: "{{SERVICE_NAME}}",
  });

  expect(() => resolveCloudRunEnv({ TEMPORAL_ENABLED: "false" })).toThrow("DATABASE_URL");
  expect(() =>
    resolveCloudRunEnv({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app?sslmode=disable",
      AUTH_ENABLED: "true",
    })
  ).toThrow("AUTH_ISSUER, AUTH_AUDIENCE, and AUTH_JWKS_URL");
});

test("generated target env schemas stay separated", () => {
  const cloudRunEnv = resolveCloudRunEnv({
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app?sslmode=disable",
    TRIGGER_SECRET_KEY: "trigger-secret",
  });
  expect("TRIGGER_SECRET_KEY" in cloudRunEnv).toBeFalse();

  const workersEnv = resolveWorkersRuntimeEnv({
    AUTH_ENABLED: "true",
    AUTH_ISSUER: "https://auth.example.com/api/auth",
    AUTH_AUDIENCE: "api://waitlist",
    AUTH_JWKS_URL: "https://auth.example.com/api/auth/jwks",
    TRIGGER_SECRET_KEY: "tr_dev_secret",
    TEMPORAL_ADDRESS: "localhost:7233",
  });
  expect(workersEnv).toMatchObject({
    AUTH_ENABLED: true,
    AUTH_AUDIENCE: "api://waitlist",
    TRIGGER_SECRET_KEY: "tr_dev_secret",
    TRIGGER_TASK_ID: "{{SERVICE_ID}}-waitlist-follow-up",
    TRIGGER_API_URL: "https://api.trigger.dev",
  });
  expect("TEMPORAL_ADDRESS" in workersEnv).toBeFalse();
});

test("generated Workers provisioning env fails before deploy when Trigger.dev env is missing", () => {
  expect(() => resolveWorkersProvisioningEnv({})).toThrow("TRIGGER_PROJECT_REF");
  expect(() =>
    resolveWorkersProvisioningEnv({
      TRIGGER_PROJECT_REF: "proj_123",
      TRIGGER_ACCESS_TOKEN: "token_123",
      TRIGGER_SECRET_KEY: "tr_dev_secret",
    })
  ).not.toThrow();
});
