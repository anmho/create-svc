import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findGeneratedServiceRoot, generatedDependenciesInstalled, normalizeScaffoldArgs } from "./service";

test("normalizeScaffoldArgs treats service create as the scaffold command outside a service repo", () => {
  expect(normalizeScaffoldArgs(["create", "launch-api", "--yes"])).toEqual(["launch-api", "--yes"]);
  expect(normalizeScaffoldArgs(["new", "launch-api"])).toEqual(["launch-api"]);
  expect(normalizeScaffoldArgs(["init", "launch-api"])).toEqual(["launch-api"]);
  expect(normalizeScaffoldArgs(["launch-api", "--yes"])).toEqual(["launch-api", "--yes"]);
});

test("normalizeScaffoldArgs maps service help to generator help outside a service repo", () => {
  expect(normalizeScaffoldArgs(["help"])).toEqual(["--help"]);
  expect(normalizeScaffoldArgs(["help", "--verbose"])).toEqual(["--help", "--verbose"]);
});

test("findGeneratedServiceRoot detects generated service context from nested directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-service-root-"));
  const serviceRoot = join(root, "generated-api");
  const nested = join(serviceRoot, "src", "waitlist");
  await mkdir(nested, { recursive: true });
  await writeFile(join(serviceRoot, "service.config.ts"), "export default {}");

  expect(findGeneratedServiceRoot(nested)).toBe(serviceRoot);
  expect(findGeneratedServiceRoot(root)).toBeUndefined();
});

test("generatedDependenciesInstalled requires node_modules when package.json exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-generated-deps-"));
  expect(generatedDependenciesInstalled(root)).toBeTrue();

  await writeFile(join(root, "package.json"), "{}");
  expect(generatedDependenciesInstalled(root)).toBeFalse();

  await mkdir(join(root, "node_modules"));
  expect(generatedDependenciesInstalled(root)).toBeTrue();
});
