import { Client, Connection } from "@temporalio/client";
import type { WaitlistFollowUpInput } from "./activities";
import { waitlistFollowUpWorkflow } from "./workflows";

export function temporalClientEnabled() {
  return (Bun.env.TEMPORAL_ENABLED ?? "").trim().toLowerCase() === "true";
}

export async function startWaitlistFollowUpWorkflow(input: WaitlistFollowUpInput) {
  if (!temporalClientEnabled()) {
    return undefined;
  }

  const address = Bun.env.TEMPORAL_ADDRESS || "localhost:7233";
  const namespace = Bun.env.TEMPORAL_NAMESPACE || "default";
  const taskQueue = Bun.env.TEMPORAL_TASK_QUEUE || "{{SERVICE_NAME}}";
  const apiKey = Bun.env.TEMPORAL_API_KEY?.trim();
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
