import type { WaitlistTrigger } from "@/waitlist/types";

export type TriggerRun = {
  id: string;
};

export type TriggerDispatcher = {
  dispatchWaitlistFollowUp(trigger: WaitlistTrigger, env: TriggerEnv): Promise<TriggerRun>;
};

export type TriggerEnv = {
  TRIGGER_SECRET_KEY?: string;
  TRIGGER_TASK_ID?: string;
  TRIGGER_API_URL?: string;
};

export class TriggerDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createTriggerDevDispatcher(): TriggerDispatcher {
  return {
    async dispatchWaitlistFollowUp(trigger, env) {
      const config = triggerConfigFromEnv(env);
      const response = await fetch(`${config.apiUrl}/api/v1/tasks/${encodeURIComponent(config.taskId)}/trigger`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          payload: {
            triggerId: trigger.id,
            type: trigger.type,
            entryId: trigger.entryId,
            payload: parsePayload(trigger.payloadJson),
          },
          options: {
            idempotencyKey: trigger.id,
          },
        }),
      });

      if (!response.ok) {
        throw new TriggerDispatchError("trigger_dev_request_failed", `Trigger.dev task trigger failed with ${response.status}: ${await response.text()}`);
      }

      const result = (await response.json()) as { id?: string };
      if (!result.id) {
        throw new TriggerDispatchError("trigger_dev_missing_run_id", "Trigger.dev did not return a run id");
      }
      return { id: result.id };
    },
  };
}

function triggerConfigFromEnv(env: TriggerEnv = {}) {
  const secretKey = env.TRIGGER_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new TriggerDispatchError("trigger_dev_not_configured", "TRIGGER_SECRET_KEY is required to dispatch Trigger.dev tasks");
  }

  return {
    secretKey,
    taskId: env.TRIGGER_TASK_ID?.trim() || "{{SERVICE_ID}}-waitlist-follow-up",
    apiUrl: (env.TRIGGER_API_URL?.trim() || "https://api.trigger.dev").replace(/\/$/, ""),
  };
}

function parsePayload(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
