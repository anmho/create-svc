import { describe, expect, test } from "bun:test";
import { buildPostScaffoldCommands } from "./post-scaffold";

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
