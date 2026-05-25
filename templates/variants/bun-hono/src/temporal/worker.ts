import { NativeConnection, Worker } from "@temporalio/worker";
import { resolveCloudRunTemporalEnv } from "../env";
import * as activities from "./activities";

export function temporalWorkerEnabled() {
  return resolveCloudRunTemporalEnv().TEMPORAL_ENABLED;
}

export async function startTemporalWorker() {
  if (!temporalWorkerEnabled()) {
    return undefined;
  }

  const env = resolveCloudRunTemporalEnv();
  const address = env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = env.TEMPORAL_TASK_QUEUE;
  const apiKey = env.TEMPORAL_API_KEY;
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
