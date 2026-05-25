package temporalapp

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

type WorkerConfig struct {
	Address   string
	Namespace string
	TaskQueue string
	APIKey    string
	TLSCACert string
	TLSCert   string
	TLSKey    string
}

func StartWorker(cfg WorkerConfig) (func(), error) {
	options, err := temporalClientOptions(cfg)
	if err != nil {
		return nil, err
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

func temporalClientOptions(cfg WorkerConfig) (client.Options, error) {
	options := client.Options{
		HostPort:  cfg.Address,
		Namespace: cfg.Namespace,
	}
	if cfg.APIKey != "" {
		options.Credentials = client.NewAPIKeyStaticCredentials(cfg.APIKey)
	}
	if cfg.TLSCACert != "" || cfg.TLSCert != "" || cfg.TLSKey != "" {
		tlsConfig, err := temporalTLSConfig(cfg)
		if err != nil {
			return client.Options{}, err
		}
		options.ConnectionOptions.TLS = tlsConfig
	}
	return options, nil
}

func temporalTLSConfig(cfg WorkerConfig) (*tls.Config, error) {
	if cfg.TLSCACert == "" || cfg.TLSCert == "" || cfg.TLSKey == "" {
		return nil, fmt.Errorf("TEMPORAL_TLS_CA_CERT, TEMPORAL_TLS_CERT, and TEMPORAL_TLS_KEY must be set together")
	}
	certificate, err := tls.X509KeyPair([]byte(cfg.TLSCert), []byte(cfg.TLSKey))
	if err != nil {
		return nil, fmt.Errorf("parse Temporal client certificate: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(cfg.TLSCACert)) {
		return nil, fmt.Errorf("parse Temporal CA certificate")
	}
	serverName, _, err := net.SplitHostPort(cfg.Address)
	if err != nil {
		serverName = cfg.Address
	}
	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		RootCAs:      roots,
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS12,
	}, nil
}
