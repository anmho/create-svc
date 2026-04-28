import { expect, test } from "bun:test";

test("go test ./...", { timeout: 60_000 }, () => {
  const go = Bun.which("go");
  expect(go, "go must be installed and available on PATH").toBeString();

  const result = Bun.spawnSync([go, "test", "./..."], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`.trim();
  expect(result.exitCode, output || "go test ./... failed").toBe(0);
});
