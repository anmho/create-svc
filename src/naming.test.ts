import { expect, test } from "bun:test";
import {
  SERVICES_PROJECT_DEFAULT,
  buildGcpProjectOptions,
  compactDatabaseName,
  compactIdentifier,
  deriveDefaults,
  deriveLocalPostgresPort,
} from "./naming";

test("deriveDefaults uses the service name for project, repo, and database naming", () => {
  expect(deriveDefaults("edge-api")).toEqual({
    serviceId: "edge-api",
    serviceName: "edge-api",
    projectName: "edge-api",
    projectId: "anmho-edge-api",
    cloudRunService: "edge-api",
    neonDatabaseName: "edge_api",
    localDatabasePort: deriveLocalPostgresPort("edge-api"),
    apiHostname: "api.edge-api.anmho.com",
    modulePath: "github.com/anmho/edge-api",
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

test("buildGcpProjectOptions puts the shared services project first", () => {
  const options = buildGcpProjectOptions("preview-worker", "anmho-preview-worker", "preview-worker", [
    { projectId: "anmho-existing", name: "existing" },
  ]);

  expect(options[0]).toEqual({
    label: `Use shared services project: services (${SERVICES_PROJECT_DEFAULT})`,
    mode: "use_existing",
    projectId: "anmho-services",
    projectName: "services",
  });
  expect(options[1]?.mode).toBe("use_existing");
  expect(options[2]?.mode).toBe("create_new");
});
