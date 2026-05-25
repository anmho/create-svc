import { expect, test } from "bun:test";
import { buildServiceDoctorReport, findServiceBinaries } from "./service-diagnostics";

test("findServiceBinaries finds service commands on a provided PATH", () => {
  const binaries = findServiceBinaries({
    pathEnv: ["/old/bin", "/fresh/bin", "/missing/bin"].join(":"),
    isExecutable: (path) => path === "/old/bin/service" || path === "/fresh/bin/service",
  });

  expect(binaries).toEqual(["/old/bin/service", "/fresh/bin/service"]);
});

test("buildServiceDoctorReport includes the active binary, package root, and version", () => {
  const report = buildServiceDoctorReport({
    activeBinaryPath: "/fresh/bin/service",
    packageRoot: "/fresh/lib/node_modules/create-svc",
    packageVersion: "0.1.77",
    latestVersion: "0.1.77",
    serviceBinaries: ["/fresh/bin/service"],
    getBinaryVersion: () => "0.1.77",
  });

  expect(report.exitCode).toBe(0);
  expect(report.text).toContain("active binary: /fresh/bin/service");
  expect(report.text).toContain("package root: /fresh/lib/node_modules/create-svc");
  expect(report.text).toContain("package version: 0.1.77");
  expect(report.text).toContain("npm latest: 0.1.77");
});

test("buildServiceDoctorReport warns when stale service binaries are also on PATH", () => {
  const report = buildServiceDoctorReport({
    activeBinaryPath: "/fresh/bin/service",
    packageRoot: "/fresh/lib/node_modules/create-svc",
    packageVersion: "0.1.77",
    latestVersion: "0.1.77",
    serviceBinaries: ["/opt/homebrew/bin/service", "/fresh/bin/service"],
    getBinaryVersion: (path) => (path === "/opt/homebrew/bin/service" ? "0.1.10" : "0.1.77"),
  });

  expect(report.exitCode).toBe(1);
  expect(report.text).toContain("warning: multiple service binaries found on PATH");
  expect(report.text).toContain("/opt/homebrew/bin/service");
  expect(report.text).toContain("version: 0.1.10 (stale)");
  expect(report.text).toContain('cleanup: rm "/opt/homebrew/bin/service"');
  expect(report.text).toContain("update: npm install -g create-svc@latest");
});
