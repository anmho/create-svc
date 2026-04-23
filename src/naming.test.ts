import { expect, test } from "bun:test";
import { buildGcpProjectOptions, compactDatabaseName, compactIdentifier, deriveDefaults } from "./naming";

test("deriveDefaults uses the service name for project, repo, and database naming", () => {
  expect(deriveDefaults("edge-api")).toEqual({
    serviceName: "edge-api",
    projectName: "edge-api",
    projectId: "anmho-edge-api",
    githubRepo: "anmho/edge-api",
    cloudRunService: "edge-api",
    neonDatabaseName: "edge_api",
  });
});

test("compactIdentifier preserves length constraints with a stable suffix", () => {
  const value = compactIdentifier("anmho-this-is-a-very-long-service-name-for-cloud-run", 30);
  expect(value.length).toBeLessThanOrEqual(30);
  expect(value.startsWith("anmho-this-is-a-very")).toBeTrue();
});

test("compactDatabaseName switches to underscores", () => {
  expect(compactDatabaseName("preview-worker")).toBe("preview_worker");
});

test("buildGcpProjectOptions puts create-new first", () => {
  const options = buildGcpProjectOptions("preview-worker", "anmho-preview-worker", "preview-worker", [
    { projectId: "anmho-existing", name: "existing" },
  ]);

  expect(options[0]).toEqual({
    label: "Create new project: preview-worker (anmho-preview-worker)",
    mode: "create_new",
    projectId: "anmho-preview-worker",
    projectName: "preview-worker",
  });
  expect(options[1]?.mode).toBe("use_existing");
});
