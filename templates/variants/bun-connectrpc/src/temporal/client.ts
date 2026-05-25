import { Client, Connection } from "@temporalio/client";
import type { WaitlistFollowUpInput } from "./activities";
import { resolveCloudRunTemporalEnv } from "../env";
import { waitlistFollowUpWorkflow } from "./workflows";

export function temporalClientEnabled() {
  return resolveCloudRunTemporalEnv().TEMPORAL_ENABLED;
}

export async function startWaitlistFollowUpWorkflow(input: WaitlistFollowUpInput) {
  if (!temporalClientEnabled()) {
    return undefined;
  }

  const env = resolveCloudRunTemporalEnv();
  const address = env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = env.TEMPORAL_TASK_QUEUE;
  const apiKey = env.TEMPORAL_API_KEY;
  const connection = await Connection.connect({
    address,
    ...(apiKey ? { apiKey } : {}),
  });
  const client = new Client({ connection, namespace });
  return client.workflow.start(waitlistFollowUpWorkflow, {
    workflowId: `waitlist-follow-up-${input.triggerId ?? crypto.randomUUID()}`,
    taskQueue,
    args: [input],
  });
}
