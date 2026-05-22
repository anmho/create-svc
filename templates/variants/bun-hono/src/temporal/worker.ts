import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";

export function temporalWorkerEnabled() {
  return (Bun.env.TEMPORAL_ENABLED ?? "").trim().toLowerCase() === "true";
}

export async function startTemporalWorker() {
  if (!temporalWorkerEnabled()) {
    return undefined;
  }

  const address = Bun.env.TEMPORAL_ADDRESS || "localhost:7233";
  const namespace = Bun.env.TEMPORAL_NAMESPACE || "default";
  const taskQueue = Bun.env.TEMPORAL_TASK_QUEUE || "{{SERVICE_NAME}}";
  const apiKey = Bun.env.TEMPORAL_API_KEY?.trim();
  const connection = await NativeConnection.connect({
    address,
    ...(apiKey ? { apiKey } : {}),
  });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
    activities,
  });
  const running = worker.run();

  return {
    taskQueue,
    async shutdown() {
      worker.shutdown();
      await running.catch(() => undefined);
      await connection.close();
    },
  };
}
