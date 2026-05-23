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
    name: "observability README contract",
    file: "README.md",
    includes: [
      "bun run observability-bootstrap",
      "Google observability bootstrap",
      "Google Cloud Logging, Monitoring, and Trace APIs",
    ],
  });
  expect(plan[0]?.smokeChecks).toEqual([{ name: "health endpoint", path: "/healthz" }]);
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
});

test("plans the workers preset with wrangler package checks", () => {
  const plan = planValidation(["--variant", "workers-bun-hono"]);

  expect(plan[0]?.target).toBe("workers");
  expect(plan[0]?.runtime).toBe("bun");
  expect(plan[0]?.framework).toBe("hono");
  expect(plan[0]?.commandSteps).toEqual([
    { name: "install dependencies", command: ["bun", "install"] },
    { name: "run tests", command: ["bun", "run", "test"] },
    { name: "run lint", command: ["bun", "run", "lint"] },
  ]);
  expect(plan[0]?.smokeChecks).toEqual([]);
});

test("parses keep mode and rejects unknown variants", () => {
  expect(parseValidationArgs(["--keep", "--variant", "go-chi"])).toEqual({
    keep: true,
    selectedVariant: "go-chi",
    selectedProfile: "microservice",
  });
  expect(() => parseValidationArgs(["--variant", "bad"])).toThrow("Unknown generated service variant: bad");
});
