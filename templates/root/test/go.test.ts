import { expect, test } from "bun:test";

const decoder = new TextDecoder();

test(
  "go test ./...",
  { timeout: 60_000 },
  () => {
  const result = Bun.spawnSync(["go", "test", "./..."], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const output = [decoder.decode(result.stdout), decoder.decode(result.stderr)].join("").trim();
  expect(result.exitCode, output || "go test ./... failed").toBe(0);
  }
);
