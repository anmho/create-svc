import { bootstrap } from "./bootstrap";
import { config } from "./config";
import { ensureArtifactRepository, gcloud, imageUrl, requireCommand, serviceUrl, writeRenderedManifest } from "./lib";

export async function deploy(args = Bun.argv.slice(2)) {
  requireCommand("gcloud");
  requireCommand("bun");

  const ci = args.includes("--ci");
  if (!ci) {
    await bootstrap();
  }

  ensureArtifactRepository();

  const image = imageUrl();
  gcloud(["builds", "submit", "--project", config.projectId, "--region", config.region, "--tag", image]);

  const renderedManifestPath = await writeRenderedManifest(image);
  gcloud(["run", "services", "replace", renderedManifestPath.pathname, "--project", config.projectId, "--region", config.region]);
  gcloud([
    "run",
    "services",
    "add-iam-policy-binding",
    config.serviceName,
    "--project",
    config.projectId,
    "--region",
    config.region,
    "--member",
    "allUsers",
    "--role",
    "roles/run.invoker",
  ]);

  console.log(serviceUrl());
}

if (import.meta.main) {
  await deploy();
}
