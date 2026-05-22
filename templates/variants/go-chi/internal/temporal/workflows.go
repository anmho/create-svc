package temporalapp

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

func WaitlistFollowUpWorkflow(ctx workflow.Context, input WaitlistFollowUpInput) (WaitlistFollowUpResult, error) {
	options := workflow.ActivityOptions{
		StartToCloseTimeout: time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, options)

	var result WaitlistFollowUpResult
	err := workflow.ExecuteActivity(ctx, "RecordWaitlistFollowUp", input).Get(ctx, &result)
	return result, err
}
