package temporalapp

import "context"

type WaitlistFollowUpInput struct {
	TriggerID string
	Email     string
	Type      string
}

type WaitlistFollowUpResult struct {
	Status    string
	TriggerID string
	Email     string
	Type      string
}

type Activities struct{}

func (a *Activities) RecordWaitlistFollowUp(ctx context.Context, input WaitlistFollowUpInput) (WaitlistFollowUpResult, error) {
	return WaitlistFollowUpResult{
		Status:    "queued",
		TriggerID: input.TriggerID,
		Email:     input.Email,
		Type:      input.Type,
	}, nil
}
