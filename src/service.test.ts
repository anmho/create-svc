import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findGeneratedServiceRoot,
  formatOutsideServiceCommandError,
  generatedDependenciesInstalled,
  generatedServiceCommandHelp,
  createSvcVersion,
  normalizeScaffoldArgs,
} from "./service";

test("normalizeScaffoldArgs treats explicit scaffold commands as generator commands", () => {
  expect(normalizeScaffoldArgs(["create", "launch-api", "--yes"])).toEqual(["launch-api", "--yes"]);
  expect(normalizeScaffoldArgs(["new", "launch-api"])).toEqual(["launch-api"]);
  expect(normalizeScaffoldArgs(["init", "launch-api"])).toEqual(["launch-api"]);
});

test("normalizeScaffoldArgs maps service help to generator help outside a service repo", () => {
  expect(normalizeScaffoldArgs(["help"])).toEqual(["--help"]);
  expect(normalizeScaffoldArgs(["help", "--verbose"])).toEqual(["--help", "--verbose"]);
});

test("createSvcVersion reports the package version", async () => {
  const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(createSvcVersion()).toBe(packageJson.version);
});

test("formatOutsideServiceCommandError rejects repo-local commands outside generated services", () => {
  expect(formatOutsideServiceCommandError("destroy")).toContain("service destroy must be run inside a generated service repo");
  expect(formatOutsideServiceCommandError("deploy")).toContain("No service.jsonc was found");
  expect(formatOutsideServiceCommandError("protect-main")).toContain("service protect-main must be run inside a generated service repo");
});

test("formatOutsideServiceCommandError does not treat positional names as scaffold commands", () => {
  const message = formatOutsideServiceCommandError("launch-api");
  expect(message).toContain("Unknown command: launch-api");
  expect(message).toContain("service new <service_id>");
});

test("findGeneratedServiceRoot detects generated service context from nested directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-svc-service-root-"));
  const serviceRoot = join(root, "generated-api");
  const nested = join(serviceRoot, "src", "waitlist");
  await mkdir(nested, { recursive: true });
  await writeFile(join(serviceRoot, "service.jsonc"), "{}");

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

test("generatedServiceCommandHelp intercepts deploy help before side effects", () => {
  expect(generatedServiceCommandHelp(["deploy", "--help"])).toContain("service deploy");
  expect(generatedServiceCommandHelp(["deploy", "-h"])).toContain("--environment");
  expect(generatedServiceCommandHelp(["deploy"])).toBeUndefined();
  expect(generatedServiceCommandHelp(["destroy", "--help"])).toBeUndefined();
});

test("generatedServiceCommandHelp intercepts protect-main help before side effects", () => {
  expect(generatedServiceCommandHelp(["protect-main", "--help"])).toContain("service protect-main");
  expect(generatedServiceCommandHelp(["protect-main", "-h"])).toContain("--repo owner/name");
  expect(generatedServiceCommandHelp(["protect-main"])).toBeUndefined();
});
