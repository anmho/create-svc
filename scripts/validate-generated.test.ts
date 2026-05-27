import { expect, test } from "bun:test";
import { formatCommandFailure, parseValidationArgs, planValidation } from "./validate-generated";

test("plans every generated service variant by default", () => {
  const plan = planValidation([]);

  expect(plan.map((variant) => variant.name)).toEqual([
    "bun-hono",
    "bun-connectrpc",
    "go-chi",
    "go-connectrpc",
    "workers-bun-hono",
  ]);
});

test("plans webhook idempotency acceptance checks for every generated service variant", () => {
  const plan = planValidation([]);

  for (const variant of plan.filter((item) => item.target === "cloudrun")) {
    expect(variant.smokeChecks).toContainEqual({
      name: "duplicate webhook delivery is idempotent",
      kind: "webhook-idempotency",
    });
  }
});

test("plans only the selected variant when --variant is provided", () => {
  const plan = planValidation(["--variant", "bun-hono"]);

  expect(plan.map((variant) => variant.name)).toEqual(["bun-hono"]);
});

test("rejects the removed app profile", () => {
  expect(() => planValidation(["--profile", "app"])).toThrow("app profile has moved");
});

test("plans the public commands for the bun hono tracer bullet", () => {
  const plan = planValidation(["--variant", "bun-hono"]);

  expect(plan[0]?.commandSteps).toEqual([
    { name: "install dependencies", command: ["bun", "install"] },
    {
      name: "verify authctl resource-server command",
      command: ["bun", "run", "authctl", "resource-servers", "upsert", "--help"],
      failureHint:
        'Missing authctl command "resource-servers upsert". Generated services must install @anmho/authctl >=0.1.1 so auth registration can upsert resource servers.',
    },
    { name: "start local postgres", command: ["docker", "compose", "up", "-d"] },
    { name: "run migrations", command: ["bun", "run", "migrate"] },
    { name: "run tests", command: ["bun", "run", "test"] },
    { name: "run lint", command: ["bun", "run", "lint"] },
  ]);
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "observability package script",
    file: "package.json",
    includes: ['"observability-bootstrap": "service observability-bootstrap"'],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "e2e package scripts",
    file: "package.json",
    includes: [
      '"test:e2e": "bun run ./scripts/e2e.ts"',
      '"test:e2e:local": "bun run ./scripts/e2e.ts --local"',
      '"test:e2e:prod": "bun run ./scripts/e2e.ts --prod"',
    ],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "e2e test script",
    file: "scripts/e2e.ts",
    includes: [
      "Cloud Monitoring did not return current revision metrics",
      'run.googleapis.com/container/instance_count',
      "Cloud Logging did not return rows",
      "/webhooks/generated-e2e",
    ],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "branch protection package script",
    file: "package.json",
    includes: ['"protect-main": "service protect-main"'],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "branch protection README contract",
    file: "README.md",
    includes: [
      "service protect-main",
      "GitHub main branch protection",
      "service create",
      "Administration: write",
    ],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "observability README contract",
    file: "README.md",
    includes: [
      "bun run observability-bootstrap",
      "Google observability bootstrap",
      "Google Cloud Logging, Monitoring, and Trace APIs",
    ],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "observability CLI contract",
    file: "service.jsonc",
    includes: [
      '"observability"',
      "logging.googleapis.com",
      "monitoring.googleapis.com",
      "cloudtrace.googleapis.com",
    ],
  });
  expect(plan[0]?.smokeChecks).toEqual([
    { name: "health endpoint", path: "/healthz" },
    { name: "duplicate webhook delivery is idempotent", kind: "webhook-idempotency" },
  ]);
});

test("plans authctl command-surface checks for every generated variant", () => {
  const plan = planValidation([]);

  for (const variant of plan) {
    expect(variant.commandSteps).toContainEqual({
      name: "verify authctl resource-server command",
      command: ["bun", "run", "authctl", "resource-servers", "upsert", "--help"],
      failureHint:
        'Missing authctl command "resource-servers upsert". Generated services must install @anmho/authctl >=0.1.1 so auth registration can upsert resource servers.',
    });
  }
});

test("formats authctl command-surface failures with an actionable hint", () => {
  const message = formatCommandFailure(
    ["bun", "run", "authctl", "resource-servers", "upsert", "--help"],
    1,
    "error: unknown command",
    'Missing authctl command "resource-servers upsert". Generated services must install @anmho/authctl >=0.1.1 so auth registration can upsert resource servers.'
  );

  expect(message).toContain('Missing authctl command "resource-servers upsert"');
  expect(message).toContain("@anmho/authctl >=0.1.1");
  expect(message).toContain("auth registration can upsert resource servers");
});

test("plans generated workflow and README validation", () => {
  const plan = planValidation(["--variant", "bun-hono"]);
  const workflowChecks = plan[0]?.generatedChecks.filter((check) => check.name.includes("deployment"));

  expect(workflowChecks?.map((check) => check.file)).toEqual([
    ".github/workflows/preview.yml",
    ".github/workflows/preview-cleanup.yml",
    ".github/workflows/deploy.yml",
    "README.md",
  ]);
  expect(workflowChecks?.[0]?.includes).toContain("service deploy --ci --environment preview --name");
  expect(workflowChecks?.[0]?.includes).toContain("steps.pr.outputs.number");
  expect(workflowChecks?.[0]?.includes).toContain("issue_comment:");
  expect(workflowChecks?.[1]?.includes).toContain("pull_request:");
  expect(workflowChecks?.[2]?.includes).toContain("branches:");
  expect(workflowChecks?.[3]?.includes).toContain("GitHub Actions deployment");
  expect(workflowChecks?.[3]?.includes).toContain("/deploy preview");
});

test("plans generated workflow validation with service deploy commands", () => {
  const plan = planValidation(["--variant", "go-chi"]);
  const workflowChecks = plan[0]?.generatedChecks.filter((check) =>
    [".github/workflows/preview.yml", ".github/workflows/deploy.yml"].includes(check.file)
  );

  expect(workflowChecks?.[0]?.includes).toContain("service deploy --ci --environment preview --name");
  expect(workflowChecks?.[1]?.includes).toContain("service deploy --ci");
});

test("generated validation starts services with local Temporal defaults", () => {
  const plan = planValidation(["--variant", "bun-hono"]);

  expect(plan[0]?.runtimeEnv).toMatchObject({
    TEMPORAL_ENABLED: "true",
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_NAMESPACE: "default",
  });
});

test("plans connectrpc introspection checks for the bun connectrpc variant", () => {
  const plan = planValidation(["--variant=bun-connectrpc"]);

  expect(plan[0]?.commandSteps.map((step) => step.command.join(" "))).toContain("bun run gen");
  expect(plan[0]?.smokeChecks).toContainEqual({
    name: "connect json endpoint",
    kind: "connect-http",
  });
  expect(plan[0]?.smokeChecks).toContainEqual({
    name: "connectrpc introspection",
    path: "/debug/connectrpc",
  });
});

test("plans a typed gRPC client smoke for the go connectrpc variant", () => {
  const plan = planValidation(["--variant", "go-connectrpc"]);

  expect(plan[0]?.smokeChecks).toContainEqual({
    name: "typed grpc client",
    kind: "connect-client",
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "observability make target",
    file: "Makefile",
    includes: ["observability-bootstrap", "$(SERVICE) observability-bootstrap"],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "e2e make targets",
    file: "Makefile",
    includes: ["test-e2e:", "test-e2e-local:", "test-e2e-prod:", "bun run ./scripts/e2e.ts --prod"],
  });
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "branch protection make target",
    file: "Makefile",
    includes: ["protect-main:", "$(SERVICE) protect-main"],
  });
});

test("plans the workers preset with wrangler package checks", () => {
  const plan = planValidation(["--variant", "workers-bun-hono"]);

  expect(plan[0]?.target).toBe("workers");
  expect(plan[0]?.runtime).toBe("bun");
  expect(plan[0]?.framework).toBe("hono");
  expect(plan[0]?.commandSteps).toEqual([
    { name: "install dependencies", command: ["bun", "install"] },
    {
      name: "verify authctl resource-server command",
      command: ["bun", "run", "authctl", "resource-servers", "upsert", "--help"],
      failureHint:
        'Missing authctl command "resource-servers upsert". Generated services must install @anmho/authctl >=0.1.1 so auth registration can upsert resource servers.',
    },
    { name: "run tests", command: ["bun", "run", "test"] },
    { name: "run lint", command: ["bun", "run", "lint"] },
  ]);
  expect(plan[0]?.smokeChecks).toEqual([]);
  expect(plan[0]?.generatedChecks).toContainEqual({
    name: "branch protection package script",
    file: "package.json",
    includes: ['"protect-main": "service protect-main"'],
  });
});

test("parses keep mode and rejects unknown variants", () => {
  expect(parseValidationArgs(["--keep", "--variant", "go-chi"])).toEqual({
    keep: true,
    selectedVariant: "go-chi",
    selectedProfile: "microservice",
  });
  expect(() => parseValidationArgs(["--variant", "bad"])).toThrow("Unknown generated service variant: bad");
});
