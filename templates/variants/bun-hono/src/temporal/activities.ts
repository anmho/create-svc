export type WaitlistFollowUpInput = {
  triggerId?: string;
  email?: string;
  type: string;
};

export async function recordWaitlistFollowUp(input: WaitlistFollowUpInput) {
  return {
    status: "queued",
    triggerId: input.triggerId ?? null,
    email: input.email ?? null,
    type: input.type,
  };
}
