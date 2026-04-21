import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldProject } from "./scaffold";

test("scaffolds the default project shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-service-"));
  const generatedRoot = join(root, "dns-api");

  await scaffoldProject({
    directory: generatedRoot,
    serviceName: "dns-api",
    modulePath: "github.com/anmho/dns-api",
    projectId: "anmho-infra-prod",
    region: "us-west1",
    githubRepo: "anmho/dns-api",
    vaultAddr: "https://vault.anmho.com",
    vaultSecretPath: "provider/cloudflare-api-token",
    vaultSecretKey: "value",
    cloudflareZoneId: "893c2371cc222826de6e00583f4902ea",
    bufModule: "buf.build/anmho/dns-api",
    generatorRoot: join(import.meta.dir, ".."),
  });

  const entries = await readdir(generatedRoot);

  expect(entries).toContain("cmd");
  expect(entries).toContain("gen");
  expect(entries).toContain("internal");
  expect(entries).toContain("scripts");
  expect(entries).toContain("service.yaml");

  const manifest = await Bun.file(join(generatedRoot, "service.yaml")).text();
  expect(manifest).toContain("serving.knative.dev/v1");
  expect(manifest.includes("{{")).toBeFalse();

  const deployScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "deploy.ts")).text();
  expect(deployScript).toContain('"run", "services", "replace"');

  const configScript = await Bun.file(join(generatedRoot, "scripts", "cloudrun", "config.ts")).text();
  expect(configScript).toContain('serviceName: "dns-api"');

  const protoStub = await Bun.file(join(generatedRoot, "gen", "dns", "v1", "dns.pb.go")).text();
  expect(protoStub).toContain("package dnsv1");
});
