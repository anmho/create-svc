import { config } from "./config";
import { gcloud, requireCommand, requireGcloudAuth, runMain, runStep } from "./lib";

export async function observabilityBootstrap() {
  requireCommand("gcloud");
  requireGcloudAuth();

  await runStep("Enabling Google observability APIs", () =>
    gcloud(["services", "enable", ...config.observability.requiredApis, "--project", config.project.id])
  );
}

if (import.meta.main) {
  await runMain("Google observability bootstrap", async () => {
    await observabilityBootstrap();
    return `Google observability bootstrap finished for ${config.serviceName}`;
  });
}
