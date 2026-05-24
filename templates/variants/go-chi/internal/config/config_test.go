package config

import (
	"strings"
	"testing"
)

func TestLoadTemporalDefaultsToLocalDevelopment(t *testing.T) {
	setRequiredEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	if !cfg.TemporalEnabled {
		t.Fatal("Temporal should default to enabled")
	}
	if cfg.TemporalAddress != "localhost:7233" {
		t.Fatalf("unexpected Temporal address: %s", cfg.TemporalAddress)
	}
	if cfg.TemporalNamespace != "default" {
		t.Fatalf("unexpected Temporal namespace: %s", cfg.TemporalNamespace)
	}
	if cfg.TemporalTaskQueue != "{{SERVICE_NAME}}" {
		t.Fatalf("unexpected Temporal task queue: %s", cfg.TemporalTaskQueue)
	}
}

func TestLoadTemporalOptOut(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("K_SERVICE", "svc")
	t.Setenv("TEMPORAL_ENABLED", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	if cfg.TemporalEnabled {
		t.Fatal("Temporal should be disabled")
	}
}

func TestLoadTemporalCloudRunFailsWithoutConnectionSettings(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("K_SERVICE", "svc")

	_, err := Load()
	if err == nil {
		t.Fatal("expected Temporal configuration error")
	}
	if !strings.Contains(err.Error(), "TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/app")
	t.Setenv("ATTACHMENT_BUCKET", "bucket")
	t.Setenv("ATTACHMENT_PUBLIC_BASE_URL", "https://storage.test")
}
