import { logger, task } from "@trigger.dev/sdk";

export type WaitlistFollowUpPayload = {
  triggerId: string;
  type: string;
  entryId: string | null;
  payload: unknown;
};

export const waitlistFollowUp = task({
  id: "{{SERVICE_ID}}-waitlist-follow-up",
  run: async (payload: WaitlistFollowUpPayload) => {
    logger.info("Processing waitlist follow-up", {
      triggerId: payload.triggerId,
      type: payload.type,
      entryId: payload.entryId,
    });

    return {
      status: "queued",
      triggerId: payload.triggerId,
    };
  },
});
