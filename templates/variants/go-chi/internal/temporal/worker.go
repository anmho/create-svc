package temporalapp

import (
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

type WorkerConfig struct {
	Address   string
	Namespace string
	TaskQueue string
	APIKey    string
}

func StartWorker(cfg WorkerConfig) (func(), error) {
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

	temporalWorker := worker.New(temporalClient, cfg.TaskQueue, worker.Options{})
	temporalWorker.RegisterWorkflow(WaitlistFollowUpWorkflow)
	temporalWorker.RegisterActivity(&Activities{})

	if err := temporalWorker.Start(); err != nil {
		temporalClient.Close()
		return nil, err
	}

	return func() {
		temporalWorker.Stop()
		temporalClient.Close()
	}, nil
}
