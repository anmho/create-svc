import { describe, expect, test } from "bun:test";
import {
  buildDeploymentVerificationCommands,
  buildLocalVerificationCommands,
  buildPostScaffoldCommands,
  buildPreGitBootstrapCommands,
  shouldRunLocalMigrate,
} from "./post-scaffold";

describe("buildPostScaffoldCommands", () => {
  test("runs create for HTTP services", () => {
    expect(buildPostScaffoldCommands({ framework: "hono" })).toEqual([
      { command: "service", args: ["create"] },
    ]);
  });

  test("runs create for ConnectRPC services after pre-git SDK preparation", () => {
    expect(buildPostScaffoldCommands({ framework: "connectrpc" })).toEqual([
      { command: "service", args: ["create"] },
    ]);
  });

  test("uses the workers service CLI for workers services", () => {
    expect(buildPostScaffoldCommands({ target: "workers", framework: "hono" })).toEqual([
      { command: "service", args: ["create"] },
    ]);
  });
});

describe("buildPreGitBootstrapCommands", () => {
  test("builds SDK artifacts before the initial GitHub push for ConnectRPC services", () => {
    expect(buildPreGitBootstrapCommands({ framework: "connectrpc" })).toEqual([{ command: "service", args: ["sdk", "build"] }]);
  });

  test("does not build SDK artifacts for HTTP or Workers services", () => {
    expect(buildPreGitBootstrapCommands({ framework: "hono" })).toEqual([]);
    expect(buildPreGitBootstrapCommands({ target: "workers", framework: "connectrpc" })).toEqual([]);
  });
});

describe("shouldRunLocalMigrate", () => {
  test("skips local migrate before Workers dev", () => {
    expect(shouldRunLocalMigrate({ target: "workers" })).toBe(false);
    expect(shouldRunLocalMigrate({ target: "cloudrun" })).toBe(true);
  });
});

describe("buildLocalVerificationCommands", () => {
  test("uses local curl checks for Bun Hono services", () => {
    expect(buildLocalVerificationCommands({ apiHostname: "api.launch.anmho.com", framework: "hono", runtime: "bun" })).toEqual([
      { command: "sh", args: ["-c", 'curl --fail --show-error --silent "http://127.0.0.1:3000/"'] },
      { command: "sh", args: ["-c", 'curl --fail --show-error --silent "http://127.0.0.1:3000/readyz"'] },
      {
        command: "sh",
        args: [
          "-c",
          'TOKEN="$(service auth token)" && curl --fail --show-error --silent -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/v1/admin/waitlist?limit=1"',
        ],
      },
    ]);
  });

  test("uses plaintext grpcurl for local Go ConnectRPC services", () => {
    expect(buildLocalVerificationCommands({ apiHostname: "api.launch.anmho.com", framework: "connectrpc", runtime: "go" })).toContainEqual({
      command: "sh",
      args: [
        "-c",
        'TOKEN="$(service auth token)" && grpcurl -plaintext -H "Authorization: Bearer $TOKEN" -d \'{"limit":1}\' -proto protos/waitlist/v1/waitlist.proto "127.0.0.1:8080" waitlist.v1.WaitlistService/ListWaitlistEntries',
      ],
    });
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

  test("uses public DNS resolution for Workers production verification", () => {
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
        'TOKEN="$(service auth token)" && (curl --fail --show-error --silent -H "Authorization: Bearer $TOKEN" "https://api.launch.anmho.com/v1/admin/waitlist?limit=1") || for IP in $(dig @1.1.1.1 +short api.launch.anmho.com); do curl --fail --show-error --silent --resolve "api.launch.anmho.com:443:$IP" -H "Authorization: Bearer $TOKEN" "https://api.launch.anmho.com/v1/admin/waitlist?limit=1" && exit 0; done; exit 1',
      ],
    });
  });
});
