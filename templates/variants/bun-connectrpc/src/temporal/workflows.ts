import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

const { recordWaitlistFollowUp } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
});

export async function waitlistFollowUpWorkflow(input: activities.WaitlistFollowUpInput) {
  return await recordWaitlistFollowUp(input);
}
