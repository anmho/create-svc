import { expect, test } from "bun:test";
import { authctlSpawnArgs } from "./authctl-command";

test("authctlSpawnArgs runs repo-local authctl through bun", () => {
  const args = authctlSpawnArgs({ path: "./node_modules/.bin/authctl", runWithBun: true }, ["doctor", "--json"]);

  expect(args[0]).toEndWith("bun");
  expect(args.slice(1)).toEqual(["./node_modules/.bin/authctl", "doctor", "--json"]);
});

test("authctlSpawnArgs runs global authctl directly", () => {
  expect(authctlSpawnArgs({ path: "/usr/local/bin/authctl", runWithBun: false }, ["version"])).toEqual([
    "/usr/local/bin/authctl",
    "version",
  ]);
});
