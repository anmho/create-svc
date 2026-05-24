package temporalapp

import (
	"context"

	"{{MODULE_PATH}}/internal/app"

	"go.temporal.io/sdk/client"
)

type TriggerDispatcher struct {
	client    client.Client
	taskQueue string
}

func NewTriggerDispatcher(cfg WorkerConfig) (*TriggerDispatcher, error) {
	options := client.Options{
		HostPort:  cfg.Address,
		Namespace: cfg.Namespace,
	}
	if cfg.APIKey != "" {
		options.Credentials = client.NewAPIKeyStaticCredentials(cfg.APIKey)
	}

	temporalClient, err := client.Dial(options)
	if err != nil {
		return nil, err
	}
	return &TriggerDispatcher{client: temporalClient, taskQueue: cfg.TaskQueue}, nil
}

func (d *TriggerDispatcher) Close() {
	d.client.Close()
}

func (d *TriggerDispatcher) DispatchWaitlistFollowUp(ctx context.Context, trigger app.WaitlistTrigger) error {
	_, err := d.client.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:        "waitlist-follow-up-" + trigger.ID,
		TaskQueue: d.taskQueue,
	}, WaitlistFollowUpWorkflow, WaitlistFollowUpInput{
		TriggerID: trigger.ID,
		Email:     triggerEmail(trigger.Payload),
		Type:      trigger.Type,
	})
	return err
}

func triggerEmail(payload any) string {
	values, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	email, _ := values["email"].(string)
	return email
}
