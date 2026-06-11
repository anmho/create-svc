import { assertTemporalRuntimeConfig } from "~/temporal";
import { startTemporalWorker } from "~/temporal/worker";

assertTemporalRuntimeConfig();
const temporalWorker = await startTemporalWorker();
if (!temporalWorker) {
  throw new Error("Temporal worker is disabled. Set TEMPORAL_ENABLED=true or do not run the worker process.");
}

console.log(`Temporal worker polling ${temporalWorker.taskQueue}`);

Bun.serve({
  port: Number(Bun.env.PORT ?? 8080),
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" || path === "/readyz") {
      return Response.json({ status: "ok", worker: "temporal" });
    }
    return Response.json({ status: "ok", worker: "temporal" });
  },
});
