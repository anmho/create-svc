import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { isLocalDatabaseUrl, resolveCommandPath } from "./lib";

test("resolveCommandPath prefers repo-local bins", async () => {
  const root = mkdtempSync(join(tmpdir(), "create-svc-workers-bin-"));
  try {
    const binDir = join(root, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const wrangler = join(binDir, "wrangler");
    await writeFile(wrangler, "#!/bin/sh\n");

    expect(resolveCommandPath("wrangler", root)).toBe(wrangler);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isLocalDatabaseUrl detects localhost database URLs", () => {
  expect(isLocalDatabaseUrl("postgres://postgres:postgres@127.0.0.1:5432/app")).toBe(true);
  expect(isLocalDatabaseUrl("postgres://postgres:postgres@localhost:5432/app")).toBe(true);
  expect(isLocalDatabaseUrl("postgres://user:pass@ep-example.us-east-2.aws.neon.tech/app")).toBe(false);
  expect(isLocalDatabaseUrl("not a url")).toBe(false);
});

