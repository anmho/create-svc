import { describe, expect, test } from "bun:test";
import { buildDeploymentVerificationCommands, buildPostScaffoldCommands } from "./post-scaffold";

describe("buildPostScaffoldCommands", () => {
  test("runs create and deploy for HTTP services", () => {
    expect(buildPostScaffoldCommands({ framework: "hono" })).toEqual([
      { command: "service", args: ["create"] },
      { command: "service", args: ["deploy"] },
    ]);
  });

  test("builds SDK artifacts before create and deploy for ConnectRPC services", () => {
    expect(buildPostScaffoldCommands({ framework: "connectrpc" })).toEqual([
      { command: "service", args: ["sdk", "build"] },
      { command: "service", args: ["create"] },
      { command: "service", args: ["deploy"] },
    ]);
  });

  test("uses the workers service CLI for workers services", () => {
    expect(buildPostScaffoldCommands({ target: "workers", framework: "hono" })).toEqual([
      { command: "service", args: ["create"] },
      { command: "service", args: ["deploy"] },
    ]);
  });
});

describe("buildDeploymentVerificationCommands", () => {
  test("uses curl health checks for HTTP services", () => {
    expect(buildDeploymentVerificationCommands({ apiHostname: "api.launch.anmho.com", framework: "hono", runtime: "bun" })).toEqual([
      { command: "sh", args: ["-c", 'curl --fail --show-error --silent "https://api.launch.anmho.com/"'] },
      { command: "sh", args: ["-c", 'curl --fail --show-error --silent "https://api.launch.anmho.com/readyz"'] },
      {
        command: "sh",
        args: [
          "-c",
          'TOKEN="$(service auth token)" && curl --fail --show-error --silent -H "Authorization: Bearer $TOKEN" "https://api.launch.anmho.com/v1/admin/waitlist?limit=1"',
        ],
      },
    ]);
  });

  test("uses the immediate Cloud Run service URL when project details are available", () => {
    expect(
      buildDeploymentVerificationCommands({
        apiHostname: "api.launch.anmho.com",
        framework: "hono",
        runtime: "bun",
        serviceName: "launch-api",
        gcpProject: "anmho-infra-prod",
        region: "us-west1",
      })
    ).toContainEqual({
      command: "sh",
      args: [
        "-c",
        'curl --fail --show-error --silent "$(gcloud run services describe launch-api --project anmho-infra-prod --region us-west1 \'--format=value(status.url)\')/"',
      ],
    });
  });

  test("uses auth token and grpcurl for Go ConnectRPC services", () => {
    expect(buildDeploymentVerificationCommands({ apiHostname: "api.launch.anmho.com", framework: "connectrpc", runtime: "go" })).toContainEqual({
      command: "sh",
      args: [
        "-c",
        'TOKEN="$(service auth token)" && grpcurl -H "Authorization: Bearer $TOKEN" -d \'{"limit":1}\' -proto protos/waitlist/v1/waitlist.proto "api.launch.anmho.com:443" waitlist.v1.WaitlistService/ListWaitlistEntries',
      ],
    });
  });

  test("uses the workers service CLI for protected workers verification", () => {
    expect(
      buildDeploymentVerificationCommands({
        target: "workers",
        apiHostname: "api.launch.anmho.com",
        framework: "hono",
        runtime: "bun",
      })
    ).toContainEqual({
      command: "sh",
      args: [
        "-c",
        'TOKEN="$(service auth token)" && curl --fail --show-error --silent -H "Authorization: Bearer $TOKEN" "https://api.launch.anmho.com/v1/admin/waitlist?limit=1"',
      ],
    });
  });
});
