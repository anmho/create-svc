import { describe, expect, test } from "bun:test";
import { buildDeploymentVerificationCommands, buildPostScaffoldCommands } from "./post-scaffold";

describe("buildPostScaffoldCommands", () => {
  test("runs create and deploy for HTTP services", () => {
    expect(buildPostScaffoldCommands({ framework: "hono" })).toEqual([
      { command: "bun", args: ["run", "service", "--", "create"] },
      { command: "bun", args: ["run", "service", "--", "deploy"] },
    ]);
  });

  test("builds SDK artifacts before create and deploy for ConnectRPC services", () => {
    expect(buildPostScaffoldCommands({ framework: "connectrpc" })).toEqual([
      { command: "bun", args: ["run", "service", "--", "sdk", "build"] },
      { command: "bun", args: ["run", "service", "--", "create"] },
      { command: "bun", args: ["run", "service", "--", "deploy"] },
    ]);
  });
});

describe("buildDeploymentVerificationCommands", () => {
  test("uses curl health checks for HTTP services", () => {
    expect(buildDeploymentVerificationCommands({ apiHostname: "api.launch.anmho.com", framework: "hono", runtime: "bun" })).toEqual([
      { command: "curl", args: ["--fail", "--show-error", "--silent", "https://api.launch.anmho.com/healthz"] },
      { command: "curl", args: ["--fail", "--show-error", "--silent", "https://api.launch.anmho.com/readyz"] },
    ]);
  });

  test("uses grpcurl for Go ConnectRPC services", () => {
    expect(buildDeploymentVerificationCommands({ apiHostname: "api.launch.anmho.com", framework: "connectrpc", runtime: "go" })).toContainEqual({
      command: "grpcurl",
      args: ["api.launch.anmho.com:443", "list"],
    });
  });
});
